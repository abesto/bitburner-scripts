import { NS } from '@ns';

import { AutohackContext } from 'lib/autohack/context';
import { JobType } from 'lib/autohack/executor';
import { HackOneServer } from 'lib/autohack/targeting';
import { autonuke } from 'lib/autonuke';
import { discoverHackedHosts } from 'lib/distributed';

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

class StaggeredHacks {
  private data: Map<number, HackOneServer[]> = new Map();
  private active: Set<string> = new Set();

  constructor(private ctx: AutohackContext) {}

  private hash(hack: HackOneServer): number {
    let sum = 0;
    for (let i = 0; i < hack.target.length; i += 1) {
      sum += hack.target.charCodeAt(i);
    }
    return sum % this.ctx.config.concurrentTargets;
  }

  add(hack: HackOneServer): void {
    if (!this.data.has(this.hash(hack))) {
      this.data.set(this.hash(hack), []);
    }
    this.data.get(this.hash(hack))?.push(hack);
  }

  getActive(bucket: number | null = null): HackOneServer[] {
    return this.getAll(bucket).filter(hack => this.active.has(hack.target));
  }

  getAll(bucket: number | null = null): HackOneServer[] {
    if (bucket === null) {
      return Array.from(this.data.values()).flat();
    }
    return this.data.get(bucket) || [];
  }

  rehash(): void {
    const newData: Map<number, HackOneServer[]> = new Map();
    for (const value of this.data.values()) {
      for (const hack of value) {
        if (!newData.has(this.hash(hack))) {
          newData.set(this.hash(hack), []);
        }
        newData.get(this.hash(hack))?.push(hack);
      }
    }
    this.data = newData;
  }

  activate(hacks: HackOneServer[]): void {
    for (const hack of hacks) {
      this.active.add(hack.target);
    }
  }

  async deactivate(hack: HackOneServer): Promise<void> {
    this.active.delete(hack.target);
    await hack.shutdown();
  }
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog('ALL');
  const ctx = new AutohackContext(ns);
  ctx.loadConfig();

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

  const allHacks: HackOneServer[] = [];

  // Offset computations per target server to minimize impact of calculation runtime variance
  const staggered = new StaggeredHacks(ctx);

  // Hack more servers!
  const hackMore = async () => {
    const util = ctx.executor.utilization;
    if (util < ctx.config.retargetUtilThreshold) {
      const capacity = ctx.executor.getMaximumThreads(JobType.Grow);
      const capacityToHack = (s: string, tickLength: number) =>
        ctx.formulas.estimateStableThreadCount(s, ctx.config.targetMoneyRatio, tickLength) / capacity;

      for (const server of discoverHackedHosts(ns).filter(s => ns.getServerMaxMoney(s))) {
        if (!allHacks.find(h => h.target === server)) {
          const hack = new HackOneServer(ctx, server);
          allHacks.push(hack);
          staggered.add(hack);
          if (!hack.statemachine.isSteadyState) {
            await hack.tick();
            ctx.debug.Targeting_prepare(`Prepping ${hack.target}`);
          }
        }
      }
      allHacks.sort((a, b) => capacityToHack(a.target, ctx.tickLength) - capacityToHack(b.target, ctx.tickLength));

      const toActivate: HackOneServer[] = [];
      const consumed = () => toActivate.map(h => capacityToHack(h.target, h.tickLength)).reduce((a, b) => a + b, 0);
      for (const hack of allHacks) {
        if (consumed() >= ctx.config.pickServersUpToUtil) {
          break;
        }
        if (!hack.statemachine.isSteadyState) {
          continue;
        }
        hack.resetTickLength();
        toActivate.push(hack);
        if (toActivate.length > ctx.config.concurrentTargets) {
          toActivate.shift();
        }
      }

      let toWeaken = toActivate.length - 1;
      while (consumed() > ctx.config.slowServersDownToUtil && toWeaken >= 0) {
        toActivate[toWeaken].increaseTickLength();
        if (!toActivate[toWeaken].canIncreaseTickLength) {
          toWeaken -= 1;
        }
      }

      // Stop hacks against servers we don't want to hack anymore
      for (const hack of staggered.getActive()) {
        if (!toActivate.includes(hack)) {
          await staggered.deactivate(hack);
          ns.print(`Shutting down hacks against ${hack.target}`);
        }
      }

      staggered.activate(toActivate);

      ctx.debug.Targeting_maxUtil(`expected-util=${consumed()}`);
    }

    ctx.debug.Targeting_active(
      staggered
        .getActive()
        .map(h => h.target)
        .join(', '),
    );
    ctx.scheduler.setTimeout(hackMore, 10000);
  };
  await hackMore();

  // Auto-nuke every once in a while
  const runAutonuke = async () => {
    autonuke(ns);
    ctx.scheduler.setTimeout(runAutonuke, 10000);
  };
  await runAutonuke();

  // Server staggering needs to change when number of concurrent targets changes
  let lastConcurrentTargets = ctx.config.concurrentTargets;
  const rehash = async () => {
    if (lastConcurrentTargets !== ctx.config.concurrentTargets) {
      staggered.rehash();
      lastConcurrentTargets = ctx.config.concurrentTargets;
    }
    ctx.scheduler.setTimeout(rehash, ctx.config.baseTickLength * 10);
  };
  await rehash();

  const bucketLength = () => ctx.config.baseTickLength / (ctx.config.concurrentTargets + 1);
  const floorTo = (n: number, period: number) => Math.floor(n / period) * period;
  const tick = (bucket: number) => async () => {
    if (bucket >= ctx.config.concurrentTargets) {
      // Last bucket for this tick; do bookkeeping
      // Load any config changes
      ctx.loadConfig();
      // Look around the world
      const results = await ctx.executor.update();
      for (const hack of allHacks) {
        hack.handleResults(results);
      }
      // Count numbers
      await ctx.aggStats.tick();
      // And go again
      const now = Date.now();
      const nextTickAt = floorTo(now + bucketLength(), ctx.tickLength);
      ctx.scheduler.schedule({ name: 'tick/0', what: tick(0), when: nextTickAt - Date.now() });
    } else {
      // Handle hacks in this bucket, and schedule the next bucket
      const hacks = staggered.getActive(bucket);
      for (const hack of hacks) {
        await hack.tick();
        await ns.asleep(0);
      }
      const now = Date.now();
      ctx.scheduler.schedule({
        name: `tick/${bucket + 1}`,
        what: tick(bucket + 1),
        when: floorTo(now, bucketLength()) + bucketLength() - now,
      });
    }
  };
  await tick(0)();

  // Hey it's an "event loop"
  while (true) {
    const sleepAmount = await ctx.scheduler.run();
    if (sleepAmount > 0) {
      await ns.asleep(sleepAmount);
    } else {
      await ns.asleep(0);
    }
  }
}
