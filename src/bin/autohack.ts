import { NS } from '@ns';

import { CONFIG, loadConfig } from 'lib/autohack/config';
import { initDebug } from 'lib/autohack/debug';
import { Executor, JobType, Result } from 'lib/autohack/executor';
import { Statemachine } from 'lib/autohack/statemachine';
import { autonuke } from 'lib/autonuke';
import * as fmt from 'lib/fmt';
import * as formulas from 'lib/formulas';
import { Scheduler } from 'lib/scheduler';

interface JobRequest {
  target: string;
  type: JobType;
  count: number;
  length: number; // ms
  splay: boolean;
}

class Splayed {
  constructor(private executor: Executor) {}

  async exec(ns: NS, req: JobRequest): Promise<number> {
    const existing = this.executor.countThreads(req.target, req.type);
    const toRequested = req.count - existing;

    const splayedPerTick = req.splay
      ? Math.round(req.count / (req.length / CONFIG.tickLength))
      : Number.POSITIVE_INFINITY;

    const want = Math.min(toRequested, splayedPerTick);
    if (req.type === JobType.Hack) {
      /*
      ns
        .tprint(
        `want=${want} req=${req.count} existing=${existing} toRequested=${toRequested} splayedPerTick=${splayedPerTick}`,
        );
        */
    }
    if (want > 0) {
      return await this.executor.exec(req.target, req.type, want);
    }
    return 0;
  }
}

async function deleteWeakestWorker(ns: NS, executor: Executor, keep: number): Promise<string | null> {
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
  await executor.killWorkersOnHost(server);
  if (!ns.deleteServer(server)) {
    throw new Error(`Failed to delete server ${server}`);
  }
  return server;
}

interface PurchaseResult {
  deleted: string[];
  purchased: string[];
}

function biggestAffordableServer(ns: NS, money: number): number {
  let ram = 8;
  if (ns.getPurchasedServerCost(ram) > money) {
    return 0;
  }
  while (ns.getPurchasedServerCost(ram * 2) <= money) {
    ram = ram * 2;
  }
  return ram;
}

async function purchaseWorkers(ns: NS, executor: Executor): Promise<PurchaseResult> {
  const result: PurchaseResult = { deleted: [], purchased: [] };

  while (ns.getPlayer().money > CONFIG.reservedMoney) {
    const ram = biggestAffordableServer(ns, ns.getPlayer().money - CONFIG.reservedMoney);
    if (ram === 0) {
      break;
    }
    if (ns.getPurchasedServerLimit() <= ns.getPurchasedServers().length) {
      const deleted = await deleteWeakestWorker(ns, executor, ram);
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

class JobTypeStats {
  inProgressHistory: number[] = [];
  finished = 0;
  duration = 0;
  impact = 0;
  expected = 0;

  reset() {
    this.inProgressHistory = [];
    this.finished = 0;
    this.duration = 0;
    this.impact = 0;
  }
}

class Stats {
  private hacks = new JobTypeStats();
  private grows = new JobTypeStats();
  private weakens = new JobTypeStats();

  private hackCapacityHistory: number[] = [];
  private moneyRatioHistory: number[] = [];
  private securityLevelHistory: number[] = [];

  private time = 0;

  constructor(private ns: NS, private executor: Executor) {}

  async tick(): Promise<boolean> {
    this.recordServerState();
    this.recordExecutorState();
    this.time += CONFIG.tickLength;
    if (this.time >= CONFIG.statsPeriod) {
      this.print();
      this.reset();
      return true;
    }
    return false;
  }

  lastUtil(): number | null {
    const i = this.hacks.inProgressHistory.length - 1;
    return (
      (this.hacks.inProgressHistory[i] +
        this.executor.equivalentThreads(this.weakens.inProgressHistory[i], JobType.Weaken, JobType.Hack) +
        this.executor.equivalentThreads(this.grows.inProgressHistory[i], JobType.Grow, JobType.Hack)) /
      this.hackCapacityHistory[i]
    );
  }

  private recordServerState() {
    const server = CONFIG.target;
    this.moneyRatioHistory.push(this.ns.getServerMoneyAvailable(server) / this.ns.getServerMaxMoney(server));
    this.securityLevelHistory.push(this.ns.getServerSecurityLevel(server));
  }

  private recordExecutorState() {
    this.grows.inProgressHistory.push(this.executor.countThreads(CONFIG.target, JobType.Grow));
    this.hacks.inProgressHistory.push(this.executor.countThreads(CONFIG.target, JobType.Hack));
    this.weakens.inProgressHistory.push(this.executor.countThreads(CONFIG.target, JobType.Weaken));
    this.hackCapacityHistory.push(this.executor.getMaximumThreads(JobType.Hack));
  }

  expected(hacks: number, grows: number, weakens: number) {
    this.hacks.expected = hacks;
    this.grows.expected = grows;
    this.weakens.expected = weakens;
  }

  private reset() {
    this.hacks.reset();
    this.grows.reset();
    this.weakens.reset();
    this.time = 0;
    this.moneyRatioHistory = [];
    this.securityLevelHistory = [];
    this.hackCapacityHistory = [];
  }

  handleResults(results: Result[]): void {
    for (const result of results) {
      if (result.type === JobType.Hack) {
        this.hacks.finished += result.threads;
        this.hacks.duration += result.duration;
        this.hacks.impact += result.impact;
      } else if (result.type === JobType.Grow) {
        this.grows.finished += result.threads;
        this.grows.duration += result.duration;
        this.grows.impact *= result.impact;
      } else if (result.type === JobType.Weaken) {
        this.weakens.finished += result.threads;
        this.weakens.duration += result.duration;
        this.weakens.impact += result.impact;
      }
    }
  }

  private formatInProgress(history: number[]): string {
    const sum = history.reduce((a, b) => a + b, 0);
    const avg = Math.round(sum / history.length);
    return `${Math.min(...history)},${avg},${Math.max(...history)}`;
  }

  print(): void {
    this.ns.print(`== Stats at ${new Date()} after ${fmt.time(this.time)} target:${CONFIG.target} ==`);

    const utilization = [];
    for (let i = 0; i < this.hackCapacityHistory.length; i += 1) {
      utilization.push(
        (this.hacks.inProgressHistory[i] +
          this.executor.equivalentThreads(this.weakens.inProgressHistory[i], JobType.Weaken, JobType.Hack) +
          this.executor.equivalentThreads(this.grows.inProgressHistory[i], JobType.Grow, JobType.Hack)) /
          this.hackCapacityHistory[i],
      );
    }

    const lines = fmt.keyValueTabulated(
      [
        'money-ratio',
        ['min', fmt.float(Math.min(...this.moneyRatioHistory))],
        ['max', fmt.float(Math.max(...this.moneyRatioHistory))],
        ['avg', fmt.float(this.moneyRatioHistory.reduce((a, b) => a + b, 0) / this.moneyRatioHistory.length)],
        ['target', fmt.float(CONFIG.targetMoneyRatio)],
      ],
      [
        'security',
        ['min', fmt.float(Math.min(...this.securityLevelHistory))],
        ['max', fmt.float(Math.max(...this.securityLevelHistory))],
        ['avg', fmt.float(this.securityLevelHistory.reduce((a, b) => a + b, 0) / this.securityLevelHistory.length)],
        ['target', fmt.float(this.ns.getServerMinSecurityLevel(CONFIG.target))],
      ],
      [
        'utilization',
        ['min', fmt.float(Math.min(...utilization))],
        ['max', fmt.float(Math.max(...utilization))],
        ['avg', fmt.float(utilization.reduce((a, b) => a + b, 0) / utilization.length)],
        ['maxHackThreads', this.executor.getMaximumThreads(JobType.Hack).toString()],
      ],
      [
        'hacks',
        ['proc', this.formatInProgress(this.hacks.inProgressHistory)],
        ['expected', this.hacks.expected.toString()],
        ['done', this.hacks.finished.toString()],
        ['money', fmt.money(this.hacks.impact)],
        ['per-sec', fmt.money(this.hacks.impact / (this.time / 1000))],
      ],
      [
        'grows',
        ['proc', this.formatInProgress(this.grows.inProgressHistory)],
        ['expected', this.grows.expected.toString()],
        ['done', this.grows.finished.toString()],
        ['amount', fmt.float(this.grows.impact)],
      ],
      [
        'weakens',
        ['proc', this.formatInProgress(this.weakens.inProgressHistory)],
        ['expected', this.weakens.expected.toString()],
        ['done', this.weakens.finished.toString()],
        ['amount', fmt.float(this.weakens.impact)],
      ],
    );
    for (const line of lines) {
      this.ns.print(line);
    }
  }
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog('ALL');
  loadConfig(ns);
  initDebug(ns);
  fmt.init(ns);
  formulas.init(ns);

  const action = ns.args[0];
  if (action === 'kill') {
    const executor = new Executor(ns);
    await executor.update();
    await executor.killWorkers();
    return;
  }

  // Executor runs hack / grow / weaken jobs across all servers
  const executor = new Executor(ns);
  await executor.update();

  // Scheduler provides setTimeout / setInterval functionality
  const scheduler = new Scheduler(ns);

  // Statemachine is the business logic
  const statemachine = new Statemachine(ns, executor, scheduler);

  // Stats is for reporting
  const stats = new Stats(ns, executor);
  await stats.tick();
  stats.print();

  // Emergency shutdown
  const emergency = async () => {
    if (formulas.moneyRatio(CONFIG.target) < 0.2) {
      stats.handleResults(await executor.update());
      await executor.emergency();
      stats.handleResults(await executor.update());
    }
    scheduler.setTimeout(emergency, 100);
  };
  await emergency();

  // Get more / better servers if we need them, to easily move to bigger targets
  // This can run relatively rarely
  const getMoreServers = async () => {
    // TODO move threshold to config
    if ((stats.lastUtil() || 0) > 0.8) {
      const { deleted } = await purchaseWorkers(ns, executor);
      for (const server of deleted) {
        executor.hostDeleted(server);
      }
      stats.handleResults(await executor.update());
    }
    // TODO move period to config
    scheduler.setTimeout(getMoreServers, 10000);
  };
  await getMoreServers();

  const tick = async () => {
    // Round tick times so that (re)starting the script doesn't offset calculations
    if (ns.getServerMoneyAvailable(CONFIG.target) <= 0) {
      throw new Error('Oops, server is at 0 money');
    }

    stats.handleResults(await executor.update());
    await stats.tick();
    loadConfig(ns);

    // Nuke things!
    autonuke(ns);

    // Hack things
    await statemachine.tick();

    // Schedule next tick
    const nextTickAt = Math.round(((Date.now() + CONFIG.tickLength) * CONFIG.tickLength) / CONFIG.tickLength);
    scheduler.setTimeout(tick, nextTickAt - Date.now());
  };

  // Hey it's an "event loop"
  scheduler.setTimeout(tick, 0);
  while (true) {
    const sleepAmount = await scheduler.run();
    if (sleepAmount > 0) {
      await ns.sleep(sleepAmount);
    }
  }
}
