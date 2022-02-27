import { discoverHackedHosts } from '/lib/distributed';
import { stat } from 'fs';

import { NS } from '@ns';

import { CONFIG, loadConfig } from 'lib/autohack/config';
import { initDebug } from 'lib/autohack/debug';
import { Executor, JobType, Result } from 'lib/autohack/executor';
import { Statemachine } from 'lib/autohack/statemachine';
import { autonuke } from 'lib/autonuke';
import * as fmt from 'lib/fmt';
import * as formulas from 'lib/formulas';
import { Scheduler } from 'lib/scheduler';

function calcUtil(ns: NS): number {
  const servers = discoverHackedHosts(ns);
  const sumMaxRam = servers.map(server => ns.getServerMaxRam(server)).reduce((a, b) => a + b, 0);
  const sumUsedRam = servers.map(server => ns.getServerUsedRam(server)).reduce((a, b) => a + b, 0);
  return sumUsedRam / sumMaxRam;
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

  constructor(private ns: NS, private target: string, private executor: Executor) {}

  async tick(): Promise<boolean> {
    this.recordServerState();
    this.recordExecutorState();
    this.time += CONFIG.tickLength;
    if (this.time >= CONFIG.statsPeriod) {
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
    const server = this.target;
    this.moneyRatioHistory.push(this.ns.getServerMoneyAvailable(server) / this.ns.getServerMaxMoney(server));
    this.securityLevelHistory.push(this.ns.getServerSecurityLevel(server));
  }

  private recordExecutorState() {
    this.grows.inProgressHistory.push(this.executor.countThreads(this.target, JobType.Grow));
    this.hacks.inProgressHistory.push(this.executor.countThreads(this.target, JobType.Hack));
    this.weakens.inProgressHistory.push(this.executor.countThreads(this.target, JobType.Weaken));
    this.hackCapacityHistory.push(this.executor.getMaximumThreads(JobType.Hack));
  }

  expected(hacks: number, grows: number, weakens: number) {
    this.hacks.expected = hacks;
    this.grows.expected = grows;
    this.weakens.expected = weakens;
  }

  reset() {
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
      if (result.target !== this.target) {
        continue;
      }
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
    //return `${Math.min(...history)},${avg},${Math.max(...history)}`;
    return avg.toString();
  }

  shortFields(): string[] {
    return [
      this.target,
      // money ratio
      fmt.float(this.moneyRatioHistory.reduce((a, b) => a + b, 0) / this.moneyRatioHistory.length),
      // money gained
      fmt.money(this.hacks.impact),
      // security
      fmt.float(this.securityLevelHistory.reduce((a, b) => a + b, 0) / this.securityLevelHistory.length),
      // hacks in-flight | done
      `${this.formatInProgress(this.hacks.inProgressHistory)}/${this.hacks.finished}`,
      // grows in-flight | done
      `${this.formatInProgress(this.grows.inProgressHistory)}/${this.grows.finished}`,
      // weakens in-flight | done
      `${this.formatInProgress(this.weakens.inProgressHistory)}/${this.weakens.finished}`,
    ];
  }

  print(): void {
    this.ns.print(`== Stats at ${new Date()} after ${fmt.time(this.time)} target:${this.target} ==`);

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
        ['target', fmt.float(this.ns.getServerMinSecurityLevel(this.target))],
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

class AggStats {
  stats: Stats[] = [];
  time = 0;

  constructor(private ns: NS) {}

  addStats(stats: Stats): void {
    this.stats.push(stats);
  }

  async tick(): Promise<boolean> {
    for (const stats of this.stats) {
      await stats.tick();
    }
    this.time += CONFIG.tickLength;
    if (this.time >= CONFIG.statsPeriod) {
      this.print();
      this.reset();
      return true;
    }
    return false;
  }

  reset(): void {
    for (const stats of this.stats) {
      stats.reset();
    }
    this.time = 0;
  }

  print(): void {
    this.ns.print(`== Stats at ${new Date()} after ${fmt.time(this.time)} ==`);
    const rows = this.stats.map(s => s.shortFields()).filter(r => r[6] !== '0/0');
    const totals = [
      'TOTAL/AVG',
      fmt.float(rows.map(r => parseFloat(r[1])).reduce((a, b) => a + b, 0) / rows.length),
      fmt.money(rows.map(r => fmt.parseMoney(r[2])).reduce((a, b) => a + b, 0)),
      fmt.float(rows.map(r => parseFloat(r[3])).reduce((a, b) => a + b, 0) / rows.length),
      rows
        .map(r => r[4].split('/').map(s => parseInt(s)))
        .reduce((a, b) => [a[0] + b[0], a[1] + b[1]], [0, 0])
        .join('/'),
      rows
        .map(r => r[5].split('/').map(s => parseInt(s)))
        .reduce((a, b) => [a[0] + b[0], a[1] + b[1]], [0, 0])
        .join('/'),
      rows
        .map(r => r[6].split('/').map(s => parseInt(s)))
        .reduce((a, b) => [a[0] + b[0], a[1] + b[1]], [0, 0])
        .join('/'),
    ];
    for (const line of fmt.table(
      ['target', 'money-ratio', 'gain', 'security', 'hacks', 'grows', 'weakens'],
      ...rows,
      totals,
    )) {
      this.ns.print(line);
    }
    this.ns.print(`Utilization: ${fmt.float(calcUtil(this.ns))}`);
  }
}

class HackOneServer {
  private stats: Stats;
  private statemachine: Statemachine;

  constructor(
    private ns: NS,
    private target: string,
    private executor: Executor,
    private scheduler: Scheduler,
    aggStats: AggStats,
  ) {
    this.stats = new Stats(ns, target, executor);
    this.statemachine = new Statemachine(ns, target, executor, scheduler);
    aggStats.addStats(this.stats);
  }

  async startup(): Promise<void> {
    // Schedule emergency shutdown
    const emergency = async () => {
      if (formulas.moneyRatio(this.target) < 0.2) {
        this.stats.handleResults(await this.executor.update());
        await this.executor.emergency(this.target);
        this.stats.handleResults(await this.executor.update());
      }
      this.scheduler.setTimeout(emergency, 100);
    };
    await emergency();
  }

  async tick(): Promise<void> {
    if (this.ns.getServerMoneyAvailable(this.target) === 0) {
      this.ns.print(`Uh-oh, no money left on ${this.target}`);
    }
    await this.stats.tick();
    await this.statemachine.tick();
  }

  handleResults(results: Result[]): void {
    this.stats.handleResults(results);
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

  // Scheduler enables a somewhat proper event loop
  const scheduler = new Scheduler(ns);

  // AggStats collects stats across all servers
  const aggStats = new AggStats(ns);

  // Get more / better servers if we need them, to easily move to bigger targets
  // This can run relatively rarely
  const getMoreServers = async () => {
    // TODO move threshold to config
    if (calcUtil(ns) > 0.7) {
      const { deleted } = await purchaseWorkers(ns, executor);
      for (const server of deleted) {
        executor.hostDeleted(server);
      }
    }
    // TODO move period to config
    scheduler.setTimeout(getMoreServers, 5000);
  };
  await getMoreServers();

  const hacks: { [server: string]: HackOneServer } = {};

  // Hack more servers!
  const hackMore = async () => {
    const servers = discoverHackedHosts(ns);
    let sleep = 10000;
    if (calcUtil(ns) < 0.7) {
      const candidates = servers.filter(s => !(s in hacks) && ns.getServerMaxMoney(s) > 0);
      const target = candidates.sort((a, b) => ns.getWeakenTime(a) - ns.getWeakenTime(b))[0];
      hacks[target] = new HackOneServer(ns, target, executor, scheduler, aggStats);
      await hacks[target].startup();
      ns.print(`Starting autohack against ${target}`);

      // Quickly start up against all tiny servers; let others start workers before we look at utilization again
      const weakenTime = formulas.getWeakenTime(target);
      if (weakenTime < 30000) {
        sleep = 0;
      } else {
        sleep = weakenTime * 3;
      }
    }
    scheduler.setTimeout(hackMore, sleep);
  };
  await hackMore();

  // Auto-nuke every once in a while
  const runAutonuke = async () => {
    autonuke(ns);
    scheduler.setTimeout(runAutonuke, 10000);
  };
  await runAutonuke();

  const tick = async () => {
    // Round tick times so that (re)starting the script doesn't offset calculations
    loadConfig(ns);

    // Run hacks
    const hackedServers = Object.keys(hacks);
    hackedServers.sort((a, b) => ns.getWeakenTime(b) - ns.getWeakenTime(a));
    // TODO move limit to config, maybe tweak it at runtime based on how long each tick takes to process
    const topHackedServers = hackedServers.slice(0, 5);
    const topHacks = topHackedServers.map(s => hacks[s]);
    const results = await executor.update();
    for (const hack of topHacks) {
      hack.handleResults(results);
      await hack.tick();
      await ns.asleep(0);
      const otherResults = await executor.update();
      for (const otherHack of topHacks) {
        otherHack.handleResults(otherResults);
      }
    }

    await aggStats.tick();

    // Schedule next tick
    const nextTickAt = Math.round(((Date.now() + CONFIG.tickLength) * CONFIG.tickLength) / CONFIG.tickLength);
    scheduler.setTimeout(tick, nextTickAt - Date.now());
  };

  // Hey it's an "event loop"
  await tick();
  while (true) {
    const sleepAmount = await scheduler.run();
    if (sleepAmount > 0) {
      await ns.asleep(sleepAmount);
    } else {
      await ns.asleep(0);
    }
  }
}
