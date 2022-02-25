import { NS } from '@ns';

import { CONFIG, loadConfig } from 'bin/autohack/config';
import {
  Executor,
  JobType,
  Result,
  scriptDir as executorScriptDir,
  Scripts as ExecutorScripts,
} from 'bin/autohack/executor';
import { autonuke } from 'lib/autonuke';
import { discoverHackedHosts } from 'lib/distributed';
import * as fmt from 'lib/fmt';

async function killWorkersOnHost(ns: NS, host: string, type: JobType | null = null): Promise<number> {
  let killed = 0;
  for (const process of ns.ps(host)) {
    if (type === null && !process.filename.startsWith(executorScriptDir)) {
      continue;
    }
    if (type !== null && process.filename !== ExecutorScripts[type]) {
      continue;
    }
    await ns.kill(process.filename, host, ...process.args);
    killed += process.threads;
  }
  return killed;
}

async function killWorkers(ns: NS, type: JobType | null = null): Promise<void> {
  const hosts = discoverHackedHosts(ns);
  let killed = 0;
  for (const host of hosts) {
    killed += await killWorkersOnHost(ns, host, type);
  }
  ns.print(`Killed ${killed} workers (type=${type})`);
}

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
      return await this.executor.exec(ns, req.target, req.type, want);
    }
    return 0;
  }
}

async function deleteWeakestWorker(ns: NS, keep: number): Promise<string | null> {
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
  await killWorkersOnHost(ns, server);
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

async function purchaseWorkers(ns: NS): Promise<PurchaseResult> {
  const result: PurchaseResult = { deleted: [], purchased: [] };

  while (ns.getPlayer().money > CONFIG.reservedMoney) {
    const ram = biggestAffordableServer(ns, ns.getPlayer().money - CONFIG.reservedMoney);
    if (ram === 0) {
      break;
    }
    if (ns.getPurchasedServerLimit() <= ns.getPurchasedServers().length) {
      const deleted = await deleteWeakestWorker(ns, ram);
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

  constructor(private executor: Executor) {}

  async tick(ns: NS): Promise<boolean> {
    this.recordServerState(ns);
    this.recordExecutorState(ns);
    this.time += CONFIG.tickLength;
    if (this.time >= CONFIG.statsPeriod) {
      this.print(ns);
      this.reset();
      return true;
    }
    return false;
  }

  private recordServerState(ns: NS) {
    const server = CONFIG.target;
    this.moneyRatioHistory.push(ns.getServerMoneyAvailable(server) / ns.getServerMaxMoney(server));
    this.securityLevelHistory.push(ns.getServerSecurityLevel(server));
  }

  private recordExecutorState(ns: NS) {
    this.grows.inProgressHistory.push(this.executor.countThreads(CONFIG.target, JobType.Grow));
    this.hacks.inProgressHistory.push(this.executor.countThreads(CONFIG.target, JobType.Hack));
    this.weakens.inProgressHistory.push(this.executor.countThreads(CONFIG.target, JobType.Weaken));
    this.hackCapacityHistory.push(this.executor.getMaximumThreads(ns, JobType.Hack));
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

  print(ns: NS): void {
    ns.print(`== Stats after ${fmt.time(ns, this.time)} target:${CONFIG.target} ==`);

    const utilization = [];
    for (let i = 0; i < this.hackCapacityHistory.length; i += 1) {
      utilization.push(
        (this.hacks.inProgressHistory[i] +
          this.executor.equivalentThreads(ns, this.weakens.inProgressHistory[i], JobType.Weaken, JobType.Hack) +
          this.executor.equivalentThreads(ns, this.grows.inProgressHistory[i], JobType.Grow, JobType.Hack)) /
          this.hackCapacityHistory[i],
      );
    }

    const lines = fmt.keyValueTabulated(
      [
        'money-ratio',
        ['min', fmt.float(ns, Math.min(...this.moneyRatioHistory))],
        ['max', fmt.float(ns, Math.max(...this.moneyRatioHistory))],
        ['avg', fmt.float(ns, this.moneyRatioHistory.reduce((a, b) => a + b, 0) / this.moneyRatioHistory.length)],
        ['target', fmt.float(ns, CONFIG.targetMoneyRatio)],
      ],
      [
        'security',
        ['min', fmt.float(ns, Math.min(...this.securityLevelHistory))],
        ['max', fmt.float(ns, Math.max(...this.securityLevelHistory))],
        ['avg', fmt.float(ns, this.securityLevelHistory.reduce((a, b) => a + b, 0) / this.securityLevelHistory.length)],
        ['target', fmt.float(ns, ns.getServerMinSecurityLevel(CONFIG.target))],
      ],
      [
        'utilization',
        ['min', fmt.float(ns, Math.min(...utilization))],
        ['max', fmt.float(ns, Math.max(...utilization))],
        ['avg', fmt.float(ns, utilization.reduce((a, b) => a + b, 0) / utilization.length)],
        ['maxHackThreads', this.executor.getMaximumThreads(ns, JobType.Hack).toString()],
      ],
      [
        'hacks',
        ['proc', this.formatInProgress(this.hacks.inProgressHistory)],
        ['expected', this.hacks.expected.toString()],
        ['done', this.hacks.finished.toString()],
        ['money', fmt.money(ns, this.hacks.impact)],
        ['per-sec', fmt.money(ns, this.hacks.impact / (this.time / 1000))],
      ],
      [
        'grows',
        ['proc', this.formatInProgress(this.grows.inProgressHistory)],
        ['expected', this.grows.expected.toString()],
        ['done', this.grows.finished.toString()],
        ['amount', fmt.float(ns, this.grows.impact)],
      ],
      [
        'weakens',
        ['proc', this.formatInProgress(this.weakens.inProgressHistory)],
        ['expected', this.weakens.expected.toString()],
        ['done', this.weakens.finished.toString()],
        ['amount', fmt.float(ns, this.weakens.impact)],
      ],
    );
    for (const line of lines) {
      ns.print(line);
    }
  }
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog('ALL');
  loadConfig(ns);

  const action = ns.args[0];
  if (action === 'kill') {
    await killWorkers(ns);
    return;
  }
  const executor = new Executor();
  await executor.update(ns);

  const stats = new Stats(executor);
  await stats.tick(ns);
  stats.print(ns);

  const growTime = ns.getGrowTime(CONFIG.target);
  const hackTime = ns.getHackTime(CONFIG.target);
  const weakenTime = ns.getWeakenTime(CONFIG.target);

  while (true) {
    loadConfig(ns);
    const tickEnd = new Date().getTime() + CONFIG.tickLength;
    const targetSecurityLevel = ns.getServerMinSecurityLevel(CONFIG.target);

    // Get more / better servers
    const { deleted } = await purchaseWorkers(ns);
    for (const server of deleted) {
      executor.hostDeleted(server);
    }
    stats.handleResults(await executor.update(ns));

    // Nuke things!
    autonuke(ns);

    const growTicks = growTime / CONFIG.tickLength;
    const hackTicks = hackTime / CONFIG.tickLength;
    const weakenTicks = weakenTime / CONFIG.tickLength;

    const moneyRatio = ns.getServerMoneyAvailable(CONFIG.target) / ns.getServerMaxMoney(CONFIG.target);
    const moneyPerHack =
      ns.hackAnalyze(CONFIG.target) * ns.hackAnalyzeChance(CONFIG.target) * ns.getServerMaxMoney(CONFIG.target);

    let wantHacks = 0;
    let wantGrows = 0;
    let wantWeakens = 0;

    const SAFETY_MARGIN = 0.1;

    const calcExpectedHacks = () => Math.floor(wantHacks * hackTicks);
    const calcExpectedGrows = () =>
      Math.ceil(executor.equivalentThreads(ns, wantGrows, JobType.Grow, JobType.Hack) * growTicks);
    const calcExpectedWeakens = () =>
      Math.ceil(executor.equivalentThreads(ns, wantWeakens, JobType.Weaken, JobType.Hack) * weakenTicks);

    const calcGrows = () => {
      const moneyAfterHacks = Math.max(0, ns.getServerMaxMoney(CONFIG.target) - moneyPerHack * wantHacks);
      const wantedMultiplier = Math.max(1, ns.getServerMaxMoney(CONFIG.target) / moneyAfterHacks);
      return Math.ceil(ns.growthAnalyze(CONFIG.target, wantedMultiplier + SAFETY_MARGIN));
    };

    const calcWeakens = () => {
      const growSecurityCost = ns.growthAnalyzeSecurity(wantGrows);
      const hackSecurityCost = ns.hackAnalyzeSecurity(wantHacks);
      const securityCost = growSecurityCost + hackSecurityCost;
      const wantedSecurityDecrease = ns.getServerSecurityLevel(CONFIG.target) + securityCost - targetSecurityLevel;
      let want = 0;
      while (ns.weakenAnalyze(want) < wantedSecurityDecrease * 3) {
        want += 1;
      }
      return want;
    };

    const calcMoneyAfterHacks = () => {
      return Math.max(0, ns.getServerMaxMoney(CONFIG.target) - moneyPerHack * wantHacks);
    };

    const calcUtil = () => {
      return (
        (calcExpectedGrows() + calcExpectedHacks() + calcExpectedWeakens()) /
        executor.getMaximumThreads(ns, JobType.Hack)
      );
    };

    // If we're below the target money ratio, then grow to it
    if (moneyRatio < CONFIG.targetMoneyRatio ** 2) {
      ns.print('emergency grow');
      await killWorkers(ns, JobType.Hack);
      const wantedMultiplier = ns.getServerMaxMoney(CONFIG.target) / ns.getServerMoneyAvailable(CONFIG.target);
      wantGrows = Math.ceil(ns.growthAnalyze(CONFIG.target, wantedMultiplier));
      // Compute the amount of weaken we need to support grows
      const securityCost = ns.growthAnalyzeSecurity(wantGrows);
      const wantedSecurityDecrease = ns.getServerSecurityLevel(CONFIG.target) + securityCost - targetSecurityLevel;
      const weakenImpact = ns.weakenAnalyze(1, 1);
      wantWeakens = Math.ceil((wantedSecurityDecrease * (1 + SAFETY_MARGIN)) / weakenImpact);
    } else {
      // Calculate number of jobs that needs to finish every tick
      while (calcUtil() < 0.9) {
        const moneyAfterHacks = calcMoneyAfterHacks();
        if (moneyAfterHacks <= CONFIG.targetMoneyRatio * ns.getServerMaxMoney(CONFIG.target)) {
          break;
        }
        wantHacks += 1;
        wantGrows = calcGrows();
        wantWeakens = calcWeakens();
      }
    }

    // Expand grow, weaken threads to take most available capacity
    const mult = (executor.getMaximumThreads(ns, JobType.Grow) * 0.8) / (calcExpectedGrows() + calcExpectedWeakens());
    wantGrows *= mult;
    wantWeakens *= mult;

    // Make super sure we have enough weaken jobs, even after we'll have scheduled all these planned grow jobs
    // Not the most elegant solution, but I don't fully trust my formulas, and this is foolproof.
    while (
      wantGrows > 0 &&
      ns.weakenAnalyze(wantWeakens) <
        ns.getServerSecurityLevel(CONFIG.target) +
          ns.hackAnalyzeSecurity(wantHacks) +
          ns.growthAnalyzeSecurity(wantGrows)
    ) {
      wantWeakens += 1;
      wantGrows -= 1;
    }

    // Similarly, make sure we now have enough grows to support hacks
    while (
      wantHacks > 0 &&
      ns.growthAnalyze(CONFIG.target, wantGrows) <
        ns.getServerMaxMoney(CONFIG.target) / ns.getServerMaxMoney(CONFIG.target) - moneyPerHack * wantHacks
    ) {
      wantHacks -= 1;
    }

    wantHacks = Math.ceil(wantHacks);
    wantGrows = Math.ceil(wantGrows);
    wantWeakens = Math.ceil(wantWeakens);
    stats.expected(calcExpectedHacks(), calcExpectedGrows(), calcExpectedWeakens());

    /*
      ns.print(
        fmt.keyValue(
          ['hacks', wantHacks.toString()],
          ['grows', wantGrows.toString()],
          ['weakens', wantWeakens.toString()],
          ['expUtil', fmt.float(ns, calcUtil())],
        ),
      );
      ns.print('grow ', executor.countThreads(CONFIG.target, JobType.Weaken), ' >= ', calcExpectedWeakens());
      ns.print('hack ', executor.countThreads(CONFIG.target, JobType.Grow), ' >= ', calcExpectedGrows());
      */
    // Start weaken jobs
    const gotWeakens = await executor.exec(ns, CONFIG.target, JobType.Weaken, wantWeakens * 1.15);
    //ns.print(`weakens ${gotWeakens}/${wantWeakens}`);

    // Start grow jobs after weakens are mostly up
    if (executor.countThreads(CONFIG.target, JobType.Weaken) >= calcExpectedWeakens()) {
      const got = await executor.exec(ns, CONFIG.target, JobType.Grow, wantGrows * 1.05);
      //ns.print(`grows ${got}/${wantGrows}`);
    }

    // Start hack jobs after grows are mostly up and we're above the target money ratio
    if (executor.countThreads(CONFIG.target, JobType.Grow) >= calcExpectedGrows()) {
      const got = await executor.exec(ns, CONFIG.target, JobType.Hack, wantHacks * 0.8);
      //ns.print(`hacks ${got}/${wantHacks}`);
    }
    await ns.asleep(tickEnd - new Date().getTime());
    stats.handleResults(await executor.update(ns));
    await stats.tick(ns);
  }
}
