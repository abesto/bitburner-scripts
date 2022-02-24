import { NS } from '@ns';

import { CONFIG, loadConfig } from 'bin/autohack/config';
import {
  Executor,
  JobType,
  Result,
  scriptDir as executorScriptDir,
} from 'bin/autohack/executor';
import { autonuke } from 'lib/autonuke';
import { discoverHackedHosts } from 'lib/distributed';
import * as fmt from 'lib/fmt';

async function killWorkersOnHost(ns: NS, host: string): Promise<number> {
  let killed = 0;
  for (const process of ns.ps(host)) {
    if (process.filename == '/bin/autohack/worker.js' || process.filename.startsWith(executorScriptDir)) {
      await ns.kill(process.filename, host, ...process.args);
      killed += 1;
    }
  }
  return killed;
}

async function killWorkers(ns: NS): Promise<void> {
  const hosts = discoverHackedHosts(ns);
  let killed = 0;
  for (const host of hosts) {
    killed += await killWorkersOnHost(ns, host);
  }
  ns.print(`Killed ${killed} workers`);
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
  while (ns.getPurchasedServerCost(ram ** 2) <= money) {
    ram = ram ** 2;
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

  constructor(private targetSecurityLevel: number, private executor: Executor) {}

  async tick(ns: NS): Promise<void> {
    this.recordServerState(ns);
    this.recordExecutorState(ns);
    this.time += CONFIG.tickLength;
    if (this.time >= CONFIG.statsPeriod) {
      this.print(ns);
      this.reset();
    }
  }

  private recordServerState(ns: NS) {
    const server = CONFIG.target;
    this.moneyRatioHistory.push(ns.getServerMoneyAvailable(server) / ns.getServerMaxMoney(server));
    this.securityLevelHistory.push(ns.getServerSecurityLevel(server));
  }

  private recordExecutorState(ns: NS) {
    this.grows.inProgressHistory.push(this.executor.countThreadsByType(JobType.Grow));
    this.hacks.inProgressHistory.push(this.executor.countThreadsByType(JobType.Hack));
    this.weakens.inProgressHistory.push(this.executor.countThreadsByType(JobType.Weaken));
    this.hackCapacityHistory.push(this.executor.getMaximumThreads(ns, JobType.Hack));
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

    const lines = fmt.logKeyValueTabulated(
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
        ['target', fmt.float(ns, this.targetSecurityLevel)],
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
        ['done', this.hacks.finished.toString()],
        ['money', fmt.money(ns, this.hacks.impact)],
        ['per-sec', fmt.money(ns, this.hacks.impact / (this.time / 1000))],
      ],
      [
        'grows',
        ['proc', this.formatInProgress(this.grows.inProgressHistory)],
        ['done', this.grows.finished.toString()],
        ['amount', fmt.float(ns, this.grows.impact)],
      ],
      [
        'weakens',
        ['proc', this.formatInProgress(this.weakens.inProgressHistory)],
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
  if (action === 'kill-workers') {
    await killWorkers(ns);
  } else if (action === 'hack') {
    const executor = new Executor();
    await executor.update(ns);
    const splayed = new Splayed(executor);

    const targetSecurityLevel = ns.getServerMinSecurityLevel(CONFIG.target);

    const stats = new Stats(targetSecurityLevel, executor);
    await stats.tick(ns);
    stats.print(ns);

    while (true) {
      loadConfig(ns);
      const tickEnd = new Date().getTime() + CONFIG.tickLength;

      // Get more / better servers
      const { deleted } = await purchaseWorkers(ns);
      for (const server of deleted) {
        executor.hostDeleted(server);
      }
      stats.handleResults(await executor.update(ns));

      // Nuke things!
      autonuke(ns);

      // Some commonly used numbers
      const growTime = ns.getGrowTime(CONFIG.target);
      const hackTime = ns.getHackTime(CONFIG.target);
      const weakenTime = ns.getWeakenTime(CONFIG.target);
      const moneyRatio = ns.getServerMoneyAvailable(CONFIG.target) / ns.getServerMaxMoney(CONFIG.target);

      // Splay jobs to establish a steady stream of changes, which makes it easier for the orchestrator to react to
      // changes. EXCEPT if we're in the (initial) phase of super-low available money, in which case we'll just throw
      // everything at it, and disable hacks.
      const splay = moneyRatio >= CONFIG.targetMoneyRatio ** 2;

      // We'll reserve workers for this many hack jobs
      const maxHackJobs = splay
        ? Math.ceil(
            (ns.getServerMaxMoney(CONFIG.target) * (1 - CONFIG.targetMoneyRatio)) /
              (ns.getServerMaxMoney(CONFIG.target) *
                ns.hackAnalyze(CONFIG.target) *
                ns.hackAnalyzeChance(CONFIG.target)),
          )
        : 0;

      // Ideal number of hacks
      const moneyPerHack =
        ns.getServerMoneyAvailable(CONFIG.target) * ns.hackAnalyze(CONFIG.target) * ns.hackAnalyzeChance(CONFIG.target);
      let wantHack: number;
      if (moneyRatio >= CONFIG.targetMoneyRatio) {
        const targetAmount = ns.getServerMaxMoney(CONFIG.target) * (moneyRatio - CONFIG.targetMoneyRatio);
        wantHack = Math.min(maxHackJobs, Math.round(targetAmount / moneyPerHack));
      } else {
        wantHack = 0;
      }

      // Compute the amount of growth we need to support ideal number of hacks
      const moneyAfterHacks =
        ns.getServerMoneyAvailable(CONFIG.target) - moneyPerHack * executor.countThreads(CONFIG.target, JobType.Hack);
      let wantGrow: number;
      if (moneyRatio < 1) {
        const wantedMultiplier = Math.max(1, ns.getServerMaxMoney(CONFIG.target) / moneyAfterHacks);
        wantGrow = Math.ceil(ns.growthAnalyze(CONFIG.target, wantedMultiplier));
      } else {
        wantGrow = 0;
      }

      // Compute the amount of weaken we need
      const growSecurityCost = ns.growthAnalyzeSecurity(executor.countThreads(CONFIG.target, JobType.Grow));
      const hackSecurityCost = ns.hackAnalyzeSecurity(executor.countThreads(CONFIG.target, JobType.Hack));
      const securityCost = growSecurityCost + hackSecurityCost;
      const wantedSecurityDecrease = ns.getServerSecurityLevel(CONFIG.target) + securityCost - targetSecurityLevel;
      let wantWeaken: number;
      if (wantedSecurityDecrease > 0) {
        const weakenImpact = ns.weakenAnalyze(1, 1);
        wantWeaken = Math.ceil(wantedSecurityDecrease / weakenImpact);
      } else {
        wantWeaken = 0;
      }

      // Limit hack load to grow load
      const haveGrow = executor.countThreads(CONFIG.target, JobType.Grow);
      const finalHacks = Math.round(wantHack * Math.min(1, wantGrow ? haveGrow / wantGrow : 1));
      /*
      ns.tprint(
        `want=${wantHack} wantGrow=${wantGrow} haveGrow=${executor.countThreads(
          CONFIG.target,
          JobType.Grow,
        )} finalHack=${finalHacks}`,
      );
      */
      // Schedule hacks
      if (finalHacks > 0) {
        //ns.tprint(`${maxHackJobs} ${hacksWanted} ${moneyPerHack} ${targetAmount}`);
        await splayed.exec(ns, {
          count: wantHack,
          length: hackTime,
          splay,
          type: JobType.Hack,
          target: CONFIG.target,
        });
      }

      // Let weaken and grow jobs take up all capacity not reserved for hack jobs
      const maxWeakenAndGrowThreads =
        executor.getMaximumThreads(ns, JobType.Weaken) + executor.getMaximumThreads(ns, JobType.Grow);
      let finalWeaken = Math.floor(
        (maxWeakenAndGrowThreads - executor.equivalentThreads(ns, maxHackJobs, JobType.Hack, JobType.Weaken)) *
          (wantWeaken / (wantWeaken + wantGrow)),
      );
      let finalGrow = Math.floor(
        (maxWeakenAndGrowThreads - executor.equivalentThreads(ns, maxHackJobs, JobType.Hack, JobType.Grow)) *
          (wantGrow / (wantWeaken + wantGrow)),
      );

      // Make super sure we have enough weaken jobs, even after we'll have scheduled all these planned grow jobs
      // Not the most elegant solution, but I don't fully trust my formulas, and this is foolproof.
      while (
        finalGrow > 0 &&
        ns.weakenAnalyze(finalWeaken) <
          ns.getServerSecurityLevel(CONFIG.target) +
            hackSecurityCost +
            ns.growthAnalyzeSecurity(Math.max(executor.countThreads(CONFIG.target, JobType.Grow) + finalGrow))
      ) {
        finalWeaken += 1;
        finalGrow -= 1;
      }

      if (finalWeaken > 0) {
        await splayed.exec(ns, {
          count: finalWeaken,
          length: weakenTime,
          splay,
          type: JobType.Weaken,
          target: CONFIG.target,
        });
      }

      if (finalGrow > 0) {
        await splayed.exec(ns, {
          count: finalGrow,
          length: growTime,
          splay,
          type: JobType.Grow,
          target: CONFIG.target,
        });
      }

      await ns.asleep(tickEnd - new Date().getTime());
      stats.handleResults(await executor.update(ns));
      await stats.tick(ns);
    }
  }
}
