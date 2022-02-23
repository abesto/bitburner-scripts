import { NS } from '@ns';

import {
  Message,
  MessageType as MT,
  readMessage,
  writeMessage,
} from 'bin/autohack/messages';
import { Formats, Port } from 'lib/constants';
import { discoverHackedHosts } from 'lib/distributed';
import * as fmt from 'lib/fmt';

interface Config {
  tickLength: number;
  statsPeriod: number;
  purchaseRam: number;
  reservedMoney: number;
  targetMoneyRatio: number;
  reservedRam: number;
  target: string;
  workerScript: string;
}

const DEFAULT_CONFIG: Config = {
  tickLength: 1000,
  statsPeriod: 30000,
  purchaseRam: 64,
  reservedMoney: 0,
  targetMoneyRatio: 0.75,
  reservedRam: 16,
  target: 'n00dles',
  workerScript: '/bin/autohack/worker.js',
};

const CONFIG = DEFAULT_CONFIG;

function loadConfig(ns: NS) {
  const config = JSON.parse(ns.read('/autohack/config.txt') || '{}') as Config;
  Object.assign(CONFIG, config);
}

async function scp(ns: NS, hostname: string): Promise<void> {
  if (hostname !== ns.getHostname()) {
    await ns.scp(ns.ls(ns.getHostname(), '/bin'), hostname);
    await ns.scp(ns.ls(ns.getHostname(), '/lib'), hostname);
  }
  await ns.asleep(0);
}

async function startWorkers(ns: NS, hostname: string): Promise<number> {
  const freeMem = ns.getServerMaxRam(hostname) - ns.getServerUsedRam(hostname);
  const reservedMem = hostname === ns.getHostname() ? CONFIG.reservedRam : 0;
  const workerCount = Math.floor((freeMem - reservedMem) / ns.getScriptRam(CONFIG.workerScript));
  if (workerCount < 1) {
    return 0;
  }

  for (let i = 0; i < workerCount; i++) {
    // Yield before each exec to work around https://github.com/danielyxie/bitburner/issues/1714
    if (i < 5) {
      await ns.asleep(0);
    }
    await ns.exec(CONFIG.workerScript, hostname, 1, `${i}`);
  }

  ns.print(`Deployed ${workerCount} workers on ${hostname}`);
  return workerCount;
}

async function deployAllWorkers(ns: NS, pool: Pool): Promise<void> {
  const hosts = discoverHackedHosts(ns);
  for (const hostname of hosts) {
    await scp(ns, hostname);
    pool.setWorkerCount(hostname, await startWorkers(ns, hostname));
    await ns.asleep(0);
  }
  ns.print(`Deployed ${pool.getWorkerCount()} workers`);
}

async function killWorkersOnHost(ns: NS, host: string): Promise<number> {
  let killed = 0;
  for (const process of ns.ps(host)) {
    if (process.filename == '/bin/autohack/worker.js') {
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

type JobInFlight = {
  type: JobType;
  target: string;
};

type JobType = MT.GrowRequest | MT.HackRequest | MT.WeakenRequest;

interface JobRequest {
  target: string;
  type: JobType;
  count: number;
  length: number; // ms
  splay: boolean;
}

class JobRegistry {
  private jobs: Map<string, JobInFlight> = new Map();
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  count(target: string, type: JobType): number {
    return [...this.jobs.values()].filter(job => job.target === target && job.type === type).length;
  }

  countByType(type: JobType): number {
    return [...this.jobs.values()].filter(job => job.type === type).length;
  }

  countAll(): number {
    return [...this.jobs.values()].length;
  }

  getWorkerCount(): number {
    return this.pool.getWorkerCount();
  }

  hostKilled(host: string): void {
    for (const worker of this.jobs.keys()) {
      if (worker.startsWith(`${host}:`)) {
        this.jobs.delete(worker);
      }
    }
  }

  async want(ns: NS, drainInbox: () => Promise<void>, req: JobRequest): Promise<number> {
    const existing = this.count(req.target, req.type);
    const toMax = req.count - existing;
    const splayed = req.splay ? Math.round(req.count / (req.length / CONFIG.tickLength)) : Number.POSITIVE_INFINITY;
    const available = this.pool.getWorkerCount() * 0.9 - this.countAll();
    const want = Math.min(toMax, splayed, available);
    if (req.type === MT.HackRequest) {
      //ns.tprint(`${want} ${toMax} ${splayed} ${available} ${existing}`);
    }
    if (want > 0) {
      await this.pool.submit(ns, want, length, { type: req.type, target: req.target }, drainInbox);
    }
    return want;
  }

  recordJobStarted(ns: NS, workerHost: string, workerIndex: number, type: JobType, target: string): void {
    const worker = `${workerHost}:${workerIndex}`;
    /*
    if (this.jobs.has(worker)) {
      ns.print(
        `${workerHost}:${workerIndex} reports it started ${type} against ${target}, but we already have a job for it: ${JSON.stringify(
          this.jobs.get(worker),
        )}. Dropping the old job from the registry.`,
      );
    }
    */
    this.jobs.set(worker, { type, target });
  }

  recordJobFinished(ns: NS, workerHost: string, workerIndex: number, type: JobType, target: string): void {
    const worker = `${workerHost}:${workerIndex}`;
    const job = this.jobs.get(worker);
    if (job === undefined) {
      //ns.print(`${workerHost}:${workerIndex} reports it finished a ${type}, but we don't have a job for it.`);
      return;
    }
    /*
    if (job.type !== type) {
      ns.print(`${workerHost}:${workerIndex} reports it finished a ${type}, but we have a ${job.type} job for it.`);
    }
    if (job.target !== target) {
      ns.print(
        `${workerHost}:${workerIndex} reports it finished ${type} against ${target}, but we have a ${job.target} job for it.`,
      );
    }
    */
    this.jobs.delete(worker);
  }

  handleMessage(ns: NS, message: Message): void {
    if (message.type === MT.HackStarted || message.type === MT.WeakenStarted || message.type === MT.GrowStarted) {
      let jobType: JobType;
      if (message.type === MT.HackStarted) {
        jobType = MT.HackRequest;
      } else if (message.type === MT.WeakenStarted) {
        jobType = MT.WeakenRequest;
      } else if (message.type === MT.GrowStarted) {
        jobType = MT.GrowRequest;
      } else {
        throw new Error('This code is unreachable');
      }
      this.recordJobStarted(ns, message.workerHost, message.workerIndex, jobType, message.target);
    } else if (
      message.type === MT.HackFinished ||
      message.type === MT.WeakenFinished ||
      message.type === MT.GrowFinished
    ) {
      let jobType: JobType;
      if (message.type === MT.HackFinished) {
        jobType = MT.HackRequest;
      } else if (message.type === MT.WeakenFinished) {
        jobType = MT.WeakenRequest;
      } else if (message.type === MT.GrowFinished) {
        jobType = MT.GrowRequest;
      } else {
        throw new Error('This code is literally unreachable, wtf');
      }
      this.recordJobFinished(ns, message.workerHost, message.workerIndex, jobType, message.target);
    }
  }
}

class Pool {
  private workers: { [hostname: string]: number } = {};

  setWorkerCount(hostname: string, count: number): void {
    this.workers[hostname] = count;
  }

  getWorkerCount(): number {
    return Object.values(this.workers).reduce((a, b) => a + b, 0);
  }

  delete(hostname: string): void {
    delete this.workers[hostname];
  }

  async submit(
    ns: NS,
    count: number,
    length: number,
    message: Message,
    drainInbox: () => Promise<void>,
  ): Promise<void> {
    for (let i = 0; i < count; i++) {
      // Ignore if the queue is full, drop items from it. Better than blocking further work.
      await writeMessage(ns, Port.AutohackCommand, message);
      // Stop regularly to read our input port
      if (i % 5 === 0) {
        await drainInbox();
        await ns.asleep(0);
      }
    }
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

async function purchaseWorkers(ns: NS): Promise<PurchaseResult> {
  const ram = CONFIG.purchaseRam;
  const cost = ns.getPurchasedServerCost(ram);
  const result: PurchaseResult = { deleted: [], purchased: [] };

  while (ns.getPlayer().money - cost > CONFIG.reservedMoney) {
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

class Stats {
  hacksInProgress: number[] = [];
  hacksSucceeded = 0;
  hacksFailed = 0;
  hackedMoney = 0;
  hacksDuration = 0;

  growsInProgress: number[] = [];
  growsFinished = 0;
  growAmount = 1.0;

  weakensInProgress: number[] = [];
  weakensFinished = 0;
  weakenAmount = 0.0;

  workers: number[] = [];

  time = 0;

  targetSecurityLevel: number;
  jobRegistry: JobRegistry;

  moneyRatios: number[] = [];
  securityLevels: number[] = [];

  constructor(targetSecurityLevel: number, jobRegistry: JobRegistry) {
    this.targetSecurityLevel = targetSecurityLevel;
    this.jobRegistry = jobRegistry;
  }

  async tick(ns: NS): Promise<void> {
    this.recordServerState(ns);
    this.recordJobRegistryState();
    this.time += CONFIG.tickLength;
    if (this.time >= CONFIG.statsPeriod) {
      this.print(ns);
      this.reset();
    }
  }

  private recordServerState(ns: NS) {
    const server = CONFIG.target;
    this.moneyRatios.push(ns.getServerMoneyAvailable(server) / ns.getServerMaxMoney(server));
    this.securityLevels.push(ns.getServerSecurityLevel(server));
  }

  private recordJobRegistryState() {
    this.growsInProgress.push(this.jobRegistry.countByType(MT.GrowRequest));
    this.hacksInProgress.push(this.jobRegistry.countByType(MT.HackRequest));
    this.weakensInProgress.push(this.jobRegistry.countByType(MT.WeakenRequest));
    this.workers.push(this.jobRegistry.getWorkerCount());
  }

  private reset() {
    this.hacksSucceeded = 0;
    this.hacksFailed = 0;
    this.hackedMoney = 0;
    this.hacksDuration = 0;
    this.growsFinished = 0;
    this.growAmount = 1.0;
    this.weakensFinished = 0;
    this.weakenAmount = 0.0;
    this.time = 0;
    this.moneyRatios = [];
    this.securityLevels = [];
    this.hacksInProgress = [];
    this.growsInProgress = [];
    this.weakensInProgress = [];
    this.workers = [];
  }

  handleMessage(ns: NS, message: Message): void {
    if (message.type === MT.HackFinished) {
      if (message.success) {
        this.hacksSucceeded += 1;
        this.hackedMoney += message.amount;
        this.hacksDuration += message.duration;
      } else {
        this.hacksFailed += 1;
      }
    }

    if (message.type === MT.GrowFinished) {
      this.growsFinished += 1;
      this.growAmount *= message.amount;
    }

    if (message.type == MT.WeakenFinished) {
      this.weakensFinished += 1;
      this.weakenAmount += message.amount;
    }
  }

  private formatInProgress(history: number[]): string {
    const sum = history.reduce((a, b) => a + b, 0);
    const avg = sum / history.length;
    return `(min=${Math.min(...history)} max=${Math.max(...history)} avg=${Math.round(avg)})`;
  }

  print(ns: NS): void {
    ns.print(`== Stats after ${fmt.time(ns, this.time)} target:${CONFIG.target} ==`);
    ns.print(
      `[money-ratio] min=${fmt.float(ns, Math.min(...this.moneyRatios))} max=${ns.nFormat(
        Math.max(...this.moneyRatios),
        Formats.float,
      )} avg=${ns.nFormat(
        this.moneyRatios.reduce((a, b) => a + b, 0) / this.moneyRatios.length,
        Formats.float,
      )} target=${ns.nFormat(CONFIG.targetMoneyRatio, Formats.float)}`,
    );
    ns.print(
      `[   security] min=${ns.nFormat(Math.min(...this.securityLevels), Formats.float)} max=${ns.nFormat(
        Math.max(...this.securityLevels),
        Formats.float,
      )} avg=${ns.nFormat(
        this.securityLevels.reduce((a, b) => a + b, 0) / this.securityLevels.length,
        Formats.float,
      )} target=${ns.nFormat(this.targetSecurityLevel, Formats.float)}`,
    );
    const utilization = [];
    for (let i = 0; i < this.workers.length; i += 1) {
      utilization.push(
        (this.hacksInProgress[i] + this.weakensInProgress[i] + this.growsInProgress[i]) / this.workers[i],
      );
    }
    ns.print(
      `[utilization] min=${fmt.float(ns, Math.min(...utilization))} max=${fmt.float(
        ns,
        Math.max(...utilization),
      )} avg=${fmt.float(ns, utilization.reduce((a, b) => a + b, 0) / utilization.length)}`,
    );
    ns.print(
      `[      hacks] proc=${this.formatInProgress(this.hacksInProgress)} pass=${this.hacksSucceeded} fail=${
        this.hacksFailed
      } money=${ns.nFormat(this.hackedMoney, Formats.money)} per-sec=${ns.nFormat(
        this.hackedMoney / (this.hacksSucceeded * (this.hacksDuration / 1000)),
        Formats.money,
      )} avg=${ns.nFormat(this.hackedMoney / (this.hacksSucceeded + this.hacksFailed), Formats.money)}`,
    );
    ns.print(
      `[      grows] proc=${this.formatInProgress(this.growsInProgress)} done=${this.growsFinished} amount=${ns.nFormat(
        this.growAmount,
        Formats.float,
      )} avg=${ns.nFormat(this.growAmount / this.growsFinished, Formats.float)}`,
    );
    ns.print(
      `[    weakens] proc=${this.formatInProgress(this.weakensInProgress)} done=${
        this.weakensFinished
      } amount=${ns.nFormat(this.weakenAmount, Formats.float)} per-sec=${ns.nFormat(
        this.weakenAmount / CONFIG.statsPeriod,
        Formats.float,
      )} avg=${ns.nFormat(this.weakenAmount / this.weakensFinished, Formats.float)}`,
    );
  }
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog('ALL');
  loadConfig(ns);

  ns.clearPort(Port.AutohackCommand);
  ns.clearPort(Port.AutohackResponse);

  const action = ns.args[0];
  if (action === 'deploy-workers') {
    await deployAllWorkers(ns, new Pool());
  } else if (action === 'kill-workers') {
    await killWorkers(ns);
  } else if (action === 'hack') {
    await killWorkers(ns);

    const workerPool = new Pool();
    await deployAllWorkers(ns, workerPool);
    const jobRegistry = new JobRegistry(workerPool);

    const targetSecurityLevel = ns.getServerMinSecurityLevel(CONFIG.target);

    const stats = new Stats(targetSecurityLevel, jobRegistry);
    await stats.tick(ns);

    const drainInbox = async (): Promise<void> => {
      while (true) {
        const message = await readMessage(ns, Port.AutohackResponse);
        if (message === null) {
          break;
        }
        jobRegistry.handleMessage(ns, message);
        stats.handleMessage(ns, message);
      }
    };

    while (true) {
      loadConfig(ns);
      const tickEnd = new Date().getTime() + CONFIG.tickLength;

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

      // Get more / better servers
      const { deleted, purchased } = await purchaseWorkers(ns);
      for (const s of deleted) {
        workerPool.delete(s);
        jobRegistry.hostKilled(s);
      }
      for (const s of purchased) {
        await scp(ns, s);
        const newWorkerCount = await startWorkers(ns, s);
        workerPool.setWorkerCount(s, newWorkerCount);
      }

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
        ns.getServerMoneyAvailable(CONFIG.target) - moneyPerHack * jobRegistry.count(CONFIG.target, MT.HackRequest);
      let wantGrow: number;
      if (moneyRatio < 1) {
        const wantedMultiplier = ns.getServerMaxMoney(CONFIG.target) / moneyAfterHacks;
        wantGrow = Math.ceil(ns.growthAnalyze(CONFIG.target, wantedMultiplier));
      } else {
        wantGrow = 0;
      }

      // Compute the amount of weaken we need
      const growSecurityCost = ns.growthAnalyzeSecurity(jobRegistry.count(CONFIG.target, MT.GrowRequest));
      const hackSecurityCost = ns.hackAnalyzeSecurity(jobRegistry.count(CONFIG.target, MT.HackRequest));
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
      const haveGrow = jobRegistry.count(CONFIG.target, MT.GrowRequest);
      const finalHacks = Math.round(wantHack * Math.min(1, wantGrow ? haveGrow / wantGrow : 1));
      /*
      ns.tprint(
        `want=${wantHack} wantGrow=${wantGrow} haveGrow=${jobRegistry.count(
          CONFIG.target,
          MT.GrowRequest,
        )} finalHack=${finalHacks}`,
      );
      */
      // Schedule hacks
      if (finalHacks > 0) {
        //ns.tprint(`${maxHackJobs} ${hacksWanted} ${moneyPerHack} ${targetAmount}`);
        await jobRegistry.want(ns, drainInbox, {
          count: wantHack,
          length: hackTime,
          splay,
          type: MT.HackRequest,
          target: CONFIG.target,
        });
      }

      // Let weaken and grow jobs take up all capacity not reserved for hack jobs
      let finalWeaken = Math.ceil((workerPool.getWorkerCount() - maxHackJobs) * (wantWeaken / (wantWeaken + wantGrow)));
      let finalGrow = Math.ceil((workerPool.getWorkerCount() - maxHackJobs) * (wantGrow / (wantWeaken + wantGrow)));

      // Make super sure we have enough weaken jobs, even after we'll have scheduled all these planned grow jobs
      // Not the most elegant solution, but I don't fully trust my formulas, and this is foolproof.
      while (
        finalGrow > 0 &&
        ns.weakenAnalyze(finalWeaken) <
          ns.getServerSecurityLevel(CONFIG.target) +
            hackSecurityCost +
            ns.growthAnalyzeSecurity(Math.max(jobRegistry.count(CONFIG.target, MT.GrowRequest) + finalGrow))
      ) {
        finalWeaken += 1;
        finalGrow -= 1;
      }

      if (finalWeaken > 0) {
        await jobRegistry.want(ns, drainInbox, {
          count: finalWeaken,
          length: weakenTime,
          splay,
          type: MT.WeakenRequest,
          target: CONFIG.target,
        });
      }

      if (finalGrow > 0) {
        await jobRegistry.want(ns, drainInbox, {
          count: finalGrow,
          length: growTime,
          splay,
          type: MT.GrowRequest,
          target: CONFIG.target,
        });
      }

      while (new Date().getTime() < tickEnd) {
        await drainInbox();
        await ns.asleep(50);
      }
      await stats.tick(ns);
    }
  }
}
