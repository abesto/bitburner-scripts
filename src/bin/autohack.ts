import { strictEqual } from 'assert';

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

const TICK_LENGTH = 1000;

async function deployWorkers(ns: NS, hostname: string): Promise<number> {
  const script = '/bin/autohack/worker.js';
  const freeMem = ns.getServerMaxRam(hostname) - ns.getServerUsedRam(hostname);
  const reservedMem = hostname === ns.getHostname() ? parseInt(ns.read('/autohack/reserved-ram.txt') || '0') : 0;
  const workerCount = Math.floor((freeMem - reservedMem) / ns.getScriptRam(script));
  if (workerCount < 1) {
    return 0;
  }

  if (hostname !== ns.getHostname()) {
    await ns.scp(ns.ls(ns.getHostname(), '/bin'), hostname);
    await ns.scp(ns.ls(ns.getHostname(), '/lib'), hostname);
  }

  for (let i = 0; i < workerCount; i++) {
    // Yield before each exec to work around https://github.com/danielyxie/bitburner/issues/1714
    await ns.sleep(0);
    await ns.exec(script, hostname, 1, `${i}`);
  }

  ns.print(`Deployed ${workerCount} workers on ${hostname}`);
  return workerCount;
}

async function deployAllWorkers(ns: NS): Promise<number> {
  const hosts = discoverHackedHosts(ns);
  let sum = 0;
  for (const hostname of hosts) {
    sum += await deployWorkers(ns, hostname);
    await ns.sleep(0);
  }
  ns.print(`Deployed ${sum} workers`);
  return sum;
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
  splayOver: number; // ms
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

  getWorkerCount(): number {
    return this.pool.workers;
  }

  async want(ns: NS, req: JobRequest): Promise<number> {
    const existing = this.count(req.target, req.type);
    const toMax = req.count - existing;
    const splayed = Math.round(req.count / (req.splayOver / TICK_LENGTH));
    const want = Math.min(toMax, splayed);
    if (want > 0) {
      return await this.pool.submit(ns, want, length, { type: req.type, target: req.target });
    }
    return 0;
  }

  recordJobStarted(ns: NS, workerHost: string, workerIndex: number, type: JobType, target: string): void {
    const worker = `${workerHost}:${workerIndex}`;
    if (this.jobs.has(worker)) {
      ns.print(
        `${workerHost}:${workerIndex} reports it started hacking ${target}, but we already have a job for it: ${JSON.stringify(
          this.jobs.get(worker),
        )}. Dropping the old job from the registry.`,
      );
    }
    this.jobs.set(worker, { type, target });
  }

  recordJobFinished(ns: NS, workerHost: string, workerIndex: number, type: JobType, target: string): void {
    const worker = `${workerHost}:${workerIndex}`;
    const job = this.jobs.get(worker);
    if (job === undefined) {
      ns.print(`${workerHost}:${workerIndex} reports it finished a ${type}, but we don't have a job for it.`);
      return;
    }
    if (job.type !== type) {
      ns.print(`${workerHost}:${workerIndex} reports it finished a ${type}, but we have a ${job.type} job for it.`);
    }
    if (job.target !== target) {
      ns.print(
        `${workerHost}:${workerIndex} reports it finished hacking ${target}, but we have a ${job.target} job for it.`,
      );
    }
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
  workers: number;
  ends: number[] = [];

  constructor(workers: number) {
    this.workers = workers;
  }

  prune() {
    const now = new Date().getTime();
    while (this.ends.length > 0 && this.ends[0] < now) {
      this.ends.shift();
    }
  }

  async submit(ns: NS, count: number | null, length: number, message: Message): Promise<number> {
    this.prune();
    const available = this.workers - this.ends.length;
    const booked = Math.min(available, count || available);
    const end = new Date().getTime() + length;
    for (let i = 0; i < booked; i++) {
      this.ends.push(end);
      let popped = await writeMessage(ns, Port.AutohackCommand, message);
      while (popped) {
        await ns.sleep(100);
        popped = await writeMessage(ns, Port.AutohackCommand, popped);
      }
    }
    return booked;
  }
}

async function deleteWeakestWorker(ns: NS, keep: number): Promise<boolean> {
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
    return false;
  }
  ns.print(`Deleting weakest server: ${server} (${ns.getServerMaxRam(server)}GB)`);
  await killWorkersOnHost(ns, server);
  if (!ns.deleteServer(server)) {
    throw new Error(`Failed to delete server ${server}`);
  }
  return true;
}

async function purchaseWorkers(ns: NS): Promise<string[]> {
  const ram = parseInt(ns.read('/autohack/purchase-ram.txt' || '64'));
  const cost = ns.getPurchasedServerCost(ram);
  const workers = [];

  const reservedMoney = parseInt(ns.read('/autohack/reserved-money.txt') || '0');
  while (ns.getPlayer().money - cost > reservedMoney) {
    if (ns.getPurchasedServerLimit() <= ns.getPurchasedServers().length) {
      if (!(await deleteWeakestWorker(ns, ram))) {
        break;
      }
    }
    let index = 0;
    while (ns.serverExists(`worker-${index}`)) {
      index += 1;
    }
    const hostname = ns.purchaseServer(`worker-${index}`, ram);
    workers.push(hostname);
    ns.print(`Purchased ${hostname} with ${ram}GB RAM`);
  }

  return workers;
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

  seconds = 0;

  target: string;
  targetMoneyRatio: number;
  targetSecurityLevel: number;
  periodSeconds: number;
  jobRegistry: JobRegistry;

  moneyRatios: number[] = [];
  securityLevels: number[] = [];

  constructor(
    target: string,
    targetMoneyRatio: number,
    targetSecurityLevel: number,
    periodSeconds: number,
    jobRegistry: JobRegistry,
  ) {
    this.target = target;
    this.targetMoneyRatio = targetMoneyRatio;
    this.targetSecurityLevel = targetSecurityLevel;
    this.periodSeconds = periodSeconds;
    this.jobRegistry = jobRegistry;
  }

  async tick(ns: NS): Promise<void> {
    this.recordServerState(ns);
    this.recordJobRegistryState();
    this.seconds += 1;
    if (this.seconds % this.periodSeconds === 0) {
      this.print(ns);
      this.reset();
    }
  }

  private recordServerState(ns: NS) {
    const server = this.target;
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
    this.seconds = 0;
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
    ns.print(`== Stats after ${fmt.time(ns, this.seconds * 1000)} target:${this.target} ==`);
    ns.print(
      `[money-ratio] min=${fmt.float(ns, Math.min(...this.moneyRatios))} max=${ns.nFormat(
        Math.max(...this.moneyRatios),
        Formats.float,
      )} avg=${ns.nFormat(
        this.moneyRatios.reduce((a, b) => a + b, 0) / this.moneyRatios.length,
        Formats.float,
      )} target=${ns.nFormat(this.targetMoneyRatio, Formats.float)}`,
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
        this.hackedMoney / (this.hacksDuration / 1000),
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
        this.weakenAmount / this.periodSeconds,
        Formats.float,
      )} avg=${ns.nFormat(this.weakenAmount / this.weakensFinished, Formats.float)}`,
    );
  }
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog('ALL');

  ns.clearPort(Port.AutohackCommand);
  ns.clearPort(Port.AutohackResponse);

  const action = ns.args[0];
  if (action === 'deploy-workers') {
    await deployAllWorkers(ns);
  } else if (action === 'kill-workers') {
    await killWorkers(ns);
  } else if (action === 'hack') {
    await killWorkers(ns);
    const hostname = ns.args[1] as string;
    const workerCount = await deployAllWorkers(ns);

    const workerPool = new Pool(workerCount);
    const jobRegistry = new JobRegistry(workerPool);

    //const targetMoneyRatio = ns.getServerMoneyAvailable(hostname) / ns.getServerMaxMoney(hostname);
    const targetMoneyRatio = 0.9;
    const targetSecurityLevel = ns.getServerMinSecurityLevel(hostname);

    const stats = new Stats(
      hostname,
      targetMoneyRatio,
      targetSecurityLevel,
      parseInt(ns.read('/autohack/stats-period.txt') || '10'),
      jobRegistry,
    );
    await stats.tick(ns);

    while (true) {
      const growTime = ns.getGrowTime(hostname);
      const hackTime = ns.getHackTime(hostname);
      const weakenTime = ns.getWeakenTime(hostname);
      const maxHackJobs = Math.ceil(
        (ns.getServerMaxMoney(hostname) * (1 - targetMoneyRatio)) /
          (ns.getServerMaxMoney(hostname) * ns.hackAnalyze(hostname) * ns.hackAnalyzeChance(hostname)),
      );
      const moneyRatio = ns.getServerMoneyAvailable(hostname) / ns.getServerMaxMoney(hostname);
      const splayOver = Math.max(growTime, hackTime, weakenTime);

      const tickEnd = new Date().getTime() + TICK_LENGTH;

      for (const newServer of await purchaseWorkers(ns)) {
        const newWorkerCount = await deployWorkers(ns, newServer);
        workerPool.workers += newWorkerCount;
      }

      const moneyPerHack =
        ns.getServerMoneyAvailable(hostname) * ns.hackAnalyze(hostname) * ns.hackAnalyzeChance(hostname);
      if (moneyRatio >= targetMoneyRatio) {
        const targetAmount = ns.getServerMaxMoney(hostname) * (moneyRatio - targetMoneyRatio);
        const hacksWanted = Math.ceil(targetAmount / moneyPerHack);

        const hacksScheduled = await jobRegistry.want(ns, {
          count: hacksWanted,
          length: hackTime,
          splayOver,
          type: MT.HackRequest,
          target: hostname,
        });
        if (hacksScheduled > 0) {
          //ns.print(`[scheduled] ${hacksScheduled}/${hacksWanted} hack jobs against ${hostname} (time: ${ns.tFormat(hackTime)})`);
        }
      }

      const moneyAfterHacks =
        ns.getServerMoneyAvailable(hostname) - moneyPerHack * jobRegistry.count(hostname, MT.HackRequest);
      let wantGrow: number;
      if (moneyRatio < 1) {
        const wantedMultiplier = ns.getServerMaxMoney(hostname) / moneyAfterHacks;
        wantGrow = Math.ceil(ns.growthAnalyze(hostname, wantedMultiplier));
      } else {
        wantGrow = 0;
      }

      const growSecurityCost = ns.growthAnalyzeSecurity(jobRegistry.count(hostname, MT.GrowRequest));
      const hackSecurityCost = ns.hackAnalyzeSecurity(jobRegistry.count(hostname, MT.HackRequest));
      const securityCost = growSecurityCost + hackSecurityCost;
      let wantWeaken: number;
      if (targetSecurityLevel < ns.getServerSecurityLevel(hostname) + securityCost) {
        const weakenImpact = ns.weakenAnalyze(1, 1);
        wantWeaken = Math.ceil(
          (ns.getServerSecurityLevel(hostname) + securityCost - targetSecurityLevel) / weakenImpact,
        );
      } else {
        wantWeaken = 0;
      }

      const finalWeaken = Math.ceil((workerPool.workers - maxHackJobs) * (wantWeaken / (wantWeaken + wantGrow)));
      if (finalWeaken > 0) {
        const newJobCount = await jobRegistry.want(ns, {
          count: finalWeaken,
          length: weakenTime,
          splayOver,
          type: MT.WeakenRequest,
          target: hostname,
        });
        if (newJobCount > 0) {
          //ns.print(`[scheduled] ${newJobCount}/${wantedCount} new weaken jobs for ${hostname} (time: ${ns.tFormat(weakenTime)})`);
          //ns.print(`[security] ${ns.nFormat(ns.getServerSecurityLevel(hostname), Formats.float)} (target = ${targetSecurityLevel})`);
        }
      }

      const finalGrow = Math.ceil((workerPool.workers - maxHackJobs) * (wantGrow / (wantWeaken + wantGrow)));
      if (finalGrow > 0) {
        const newJobCount = await jobRegistry.want(ns, {
          count: finalGrow,
          length: growTime,
          splayOver,
          type: MT.GrowRequest,
          target: hostname,
        });
        if (newJobCount > 0) {
          //ns.print(`[scheduled] ${newJobCount}/${wantedCount} new growth jobs for ${hostname} (time: ${ns.tFormat(growTime)})`);
          //ns.print(`[money-ratio] ${ns.nFormat(moneyRatio, Formats.float)} (target = ${targetMoneyRatio})`);
        }
      }

      while (new Date().getTime() < tickEnd) {
        while (true) {
          const message = await readMessage(ns, Port.AutohackResponse);
          if (message === null) {
            break;
          }
          jobRegistry.handleMessage(ns, message);
          stats.handleMessage(ns, message);
        }
        await ns.sleep(50);
      }
      await stats.tick(ns);
    }
  }
}
