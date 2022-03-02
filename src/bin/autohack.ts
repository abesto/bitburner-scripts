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
  let activeHacks: HackOneServer[] = [];

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
      for (const hack of activeHacks) {
        if (!toActivate.includes(hack)) {
          await hack.shutdown();
          ns.print(`Shutting down hacks against ${hack.target}`);
        }
      }

      activeHacks = toActivate;

      ctx.debug.Targeting_maxUtil(`expected-util=${consumed()}`);
    }

    ctx.debug.Targeting_active(activeHacks.map(h => h.target).join(', '));
    ctx.scheduler.setTimeout(hackMore, 10000);
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
    for (const hack of activeHacks) {
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
