import { NS } from '@ns';

import { Config } from 'lib/autohack/config';
import { AutohackContext } from 'lib/autohack/context';
import { Executor, JobType, Result } from 'lib/autohack/executor';
import { Statemachine } from 'lib/autohack/statemachine';
import { Stats } from 'lib/autohack/stats';
import { autonuke } from 'lib/autonuke';
import { discoverHackedHosts } from 'lib/distributed';
import { Formulas } from 'lib/formulas';

async function deleteWeakestWorker(ctx: AutohackContext, keep: number): Promise<string | null> {
  const ns = ctx.ns;
  const server = ns
    .getPurchasedServers()
    .filter(h => h.startsWith('worker-'))
    .reduce((a, b) => {
      if (ns.getServerMaxRam(a) > ns.getServerMaxRam(b)) {
        return b;
      }
      return a;
    });
  if (ns.getServerMaxRam(server) >= keep) {
    //ns.print(`Not deleting weakest worker, it's too big: ${server} (${ns.getServerMaxRam(server)}GB > ${keep}GB)`);
    return null;
  }
  ns.print(`Deleting weakest server: ${server} (${ns.getServerMaxRam(server)}GB)`);
  for (const p of ns.ps(server)) {
    ns.kill(p.pid);
  }
  if (!ns.deleteServer(server)) {
    throw new Error(`Failed to delete server ${server}`);
  }
  return server;
}

interface PurchaseResult {
  deleted: string[];
  purchased: string[];
}

function biggestAffordableServer(ctx: AutohackContext): number {
  let ram = 8;
  const money = ctx.ns.getPlayer().money - ctx.config.reservedMoney;
  if (ctx.ns.getPurchasedServerCost(ram) > money) {
    return 0;
  }
  while (ctx.ns.getPurchasedServerCost(ram * 2) <= money) {
    ram = ram * 2;
  }
  return ram;
}

async function purchaseWorkers(ctx: AutohackContext): Promise<PurchaseResult> {
  const result: PurchaseResult = { deleted: [], purchased: [] };
  const { ns } = ctx;

  while (true) {
    const ram = biggestAffordableServer(ctx);
    if (ram === 0) {
      break;
    }
    if (ns.getPurchasedServerLimit() <= ns.getPurchasedServers().length) {
      const deleted = await deleteWeakestWorker(ctx, ram);
      if (deleted === null) {
        break;
      }
      result.deleted.push(deleted);
    }
    let index = 0;
    while (ns.serverExists(`worker-${index}`)) {
      index += 1;
    }
    const hostname = ns.purchaseServer(`worker-${index}`, ram);
    result.purchased.push(hostname);
    ns.print(`Purchased ${hostname} with ${ram}GB RAM`);
  }

  return result;
}

class HackOneServer {
  private stats: Stats;
  private statemachine: Statemachine;

  constructor(private ctx: AutohackContext, private target: string) {
    this.stats = new Stats(ctx, target);
    this.statemachine = new Statemachine(ctx, target);
    ctx.aggStats.addStats(this.stats);
  }

  private get formulas(): Formulas {
    return this.ctx.formulas;
  }

  private get config(): Config {
    return this.ctx.config;
  }

  private get executor(): Executor {
    return this.ctx.executor;
  }

  async shutdown(): Promise<void> {
    await this.executor.killWorkers(JobType.Hack, this.target);
    await this.executor.killWorkers(JobType.Grow, this.target);
    await this.executor.killWorkers(JobType.Weaken, this.target);
    this.ctx.aggStats.unregister(this.stats);
  }

  async tick(): Promise<void> {
    if (this.ctx.ns.getServerMoneyAvailable(this.target) === 0) {
      this.ctx.ns.print(`Uh-oh, no money left on ${this.target}`);
    }
    await this.stats.tick();
    await this.statemachine.tick();
    if (this.formulas.moneyRatio(this.target) < this.config.emergencyShutdownMoneyRatio) {
      await this.executor.emergency(this.target);
    }
  }

  handleResults(results: Result[]): void {
    this.stats.handleResults(results);
  }
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog('ALL');
  const ctx = new AutohackContext(ns);

  const action = ns.args[0];
  if (action === 'kill') {
    await ctx.executor.update();
    await ctx.executor.killWorkers();
    return;
  }

  // Take a look around
  await ctx.executor.update();

  // Get more / better servers if we need them, to easily move to bigger targets
  // This can run relatively rarely
  const getMoreServers = async () => {
    const { deleted } = await purchaseWorkers(ctx);
    for (const server of deleted) {
      ctx.executor.hostDeleted(server);
    }
    ctx.scheduler.setTimeout(getMoreServers, ctx.config.serverPurchaseInterval);
  };
  await getMoreServers();

  const hacks: { [server: string]: HackOneServer } = {};

  // Hack more servers!
  const hackMore = async () => {
    let sleep = ctx.config.retargetInterval;
    const util = ctx.executor.utilization;
    if (util < ctx.config.retargetUtilThreshold) {
      const servers = discoverHackedHosts(ns);

      const capacity = ctx.executor.getMaximumThreads(JobType.Grow);
      const capacityToHack = (s: string) =>
        ctx.formulas.estimateStableThreadCount(s, ctx.config.targetMoneyRatio, ctx.tickLength) / capacity;

      const candidates = servers.filter(s => ns.getServerMaxMoney(s) > 0 && capacityToHack(s) < 1);
      candidates.sort((a, b) => capacityToHack(b) - capacityToHack(a));

      if (candidates.length === 0) {
        ctx.increaseTickMultiplier();
        ns.print(`No servers small enough to hack. Reducing tick length and trying again.`);
        sleep = 0;
      } else {
        // Minimize tick length multiplier based on the smallest server
        while (capacityToHack(candidates[0]) < 1 && ctx.canDecreaseTickMultiplier) {
          ctx.decreaseTickMultiplier();
        }
        if (capacityToHack(candidates[0]) > 1) {
          ctx.increaseTickMultiplier();
        }

        // Find the ctx.config.concurrentTargets largest servers that best use our capacity
        const newTargets: string[] = [];
        const consumed = () => newTargets.map(s => capacityToHack(s)).reduce((a, b) => a + b, 0);
        while (consumed() < 1.1 && candidates.length > 0) {
          const target = candidates.shift();
          if (target) {
            newTargets.push(target);
            while (newTargets.length > ctx.config.concurrentTargets) {
              newTargets.shift();
            }
          }
        }

        // Stop hacks against servers we don't want to hack anymore
        for (const target in hacks) {
          if (!newTargets.includes(target)) {
            await hacks[target].shutdown();
            ns.print(`Shutting down hacks against ${target}`);
            delete hacks[target];
          }
        }

        // Start hacks against servers we newly want to hack
        for (const target of newTargets) {
          if (!(target in hacks)) {
            hacks[target] = new HackOneServer(ctx, target);
            ns.print(`Starting autohack against ${target}`);
          }
        }
      }
    }

    ctx.scheduler.setTimeout(hackMore, sleep);
  };
  await hackMore();

  // Auto-nuke every once in a while
  const runAutonuke = async () => {
    autonuke(ns);
    ctx.scheduler.setTimeout(runAutonuke, 10000);
  };
  await runAutonuke();

  const tick = async () => {
    ctx.loadConfig();

    // Run hacks
    const results = await ctx.executor.update();
    for (const hack of Object.values(hacks)) {
      hack.handleResults(results);
      await hack.tick();
      await ns.asleep(0);
    }
    await ctx.aggStats.tick();

    // Schedule next tick
    // Round tick times so that (re)starting the script doesn't offset batches
    const nextTickAt = Math.round(((Date.now() + ctx.tickLength) * ctx.tickLength) / ctx.tickLength);
    ctx.scheduler.setTimeout(tick, nextTickAt - Date.now());
  };

  // Hey it's an "event loop"
  await tick();
  while (true) {
    const sleepAmount = await ctx.scheduler.run();
    if (sleepAmount > 0) {
      await ns.asleep(sleepAmount);
    } else {
      await ns.asleep(0);
    }
  }
}
