import { notStrictEqual } from 'assert';

import { NS } from '@ns';

import { CONFIG } from 'bin/autohack/config';
import { discoverHackedHosts } from 'lib/distributed';

export enum JobType {
  Hack = 'hack',
  Grow = 'grow',
  Weaken = 'weaken',
}

export interface Result {
  target: string;
  type: JobType;
  threads: number;
  duration: number;
  impact: number;
}

export const scriptDir = '/bin/autohack/executor_scripts';

export const Scripts = {
  [JobType.Hack]: `${scriptDir}/hack.js`,
  [JobType.Grow]: `${scriptDir}/grow.js`,
  [JobType.Weaken]: `${scriptDir}/weaken.js`,
};

const ScriptToJobType = {
  [Scripts[JobType.Hack]]: JobType.Hack,
  [Scripts[JobType.Grow]]: JobType.Grow,
  [Scripts[JobType.Weaken]]: JobType.Weaken,
};

function equivalentThreads(ns: NS, n: number, from: JobType, to: JobType): number {
  const fromRam = ns.getScriptRam(Scripts[from], ns.getHostname());
  const toRam = ns.getScriptRam(Scripts[to], ns.getHostname());
  return Math.floor(n * (toRam / fromRam));
}

class Worker {
  constructor(
    private host: Host,
    private target: string,
    private type: JobType,
    private threads: number,
    private pid: number,
    private uid: string,
  ) {}

  getTarget(): string {
    return this.target;
  }

  getPid(): number {
    return this.pid;
  }

  getUid(): string {
    return this.uid;
  }

  getType(): JobType {
    return this.type;
  }

  getThreads(): number {
    return this.threads;
  }

  isRunning(ns: NS): boolean {
    return ns.isRunning(this.pid, this.host.getName(), this.target);
  }
}

class Host {
  private workers: Worker[] = [];
  constructor(private name: string) {}

  getName(): string {
    return this.name;
  }

  countThreads(target: string, type: JobType): number {
    return this.workers
      .filter(w => w.getTarget() === target && w.getType() === type)
      .map(w => w.getThreads())
      .reduce((a, b) => a + b, 0);
  }

  countThreadsByType(type: JobType): number {
    return this.workers
      .filter(w => w.getType() === type)
      .map(w => w.getThreads())
      .reduce((a, b) => a + b, 0);
  }

  countAllThreadsHackEquivalent(ns: NS): number {
    return this.workers
      .map(w => equivalentThreads(ns, w.getThreads(), w.getType(), JobType.Hack))
      .reduce((a, b) => a + b, 0);
  }

  async update(ns: NS): Promise<Result[]> {
    const liveWorkers = ns
      .ps(this.name)
      .filter(p => p.filename.startsWith(`${scriptDir}/`))
      .map(p => new Worker(this, p.args[0], ScriptToJobType[p.filename], p.threads, p.pid, p.args[1]));

    const stoppedWorkers = this.workers.filter(w => liveWorkers.find(lw => lw.getUid() === w.getUid()) === undefined);
    const results: Result[] = [];
    if (stoppedWorkers.length > 0) {
      for (const worker of stoppedWorkers) {
        const filename = `/autohack/results/${worker.getUid()}.txt`;
        if (!(this.getName() === ns.getHostname() || (await ns.scp(filename, this.getName(), ns.getHostname())))) {
          continue;
        }
        const workerDataStr = await ns.read(filename);
        if (workerDataStr !== '') {
          const result = {
            target: worker.getTarget(),
            type: worker.getType(),
            threads: worker.getThreads(),
            duration: 0,
            impact: 0,
          };
          try {
            const parsed = JSON.parse(workerDataStr);
            result.duration = parsed.duration;
            result.impact = parsed.impact;
          } finally {
            results.push(result);
          }
        }
        ns.rm(filename);
        ns.rm(filename, this.getName());
      }
    }

    this.workers = liveWorkers;

    return results;
  }

  exec(ns: NS, target: string, type: JobType, threads: number): boolean {
    const uid = `${new Date().getTime()}-${Math.random()}`;
    const pid = ns.exec(Scripts[type], this.name, threads, target, uid);
    if (pid === 0) {
      return false;
    }
    this.workers.push(new Worker(this, target, type, threads, pid, uid));
    return true;
  }

  private maxUsableRam(ns: NS): number {
    const ram = ns.getServerMaxRam(this.getName());
    if (this.getName() === ns.getHostname()) {
      return ram - CONFIG.reservedRam;
    }
    return ram;
  }

  getAvailableThreads(ns: NS, type: JobType): number {
    const free = this.maxUsableRam(ns) - ns.getServerUsedRam(this.name);
    return Math.floor(free / ns.getScriptRam(Scripts[type], this.getName()));
  }

  getMaximumThreads(ns: NS, type: JobType): number {
    /*
    ns.tprint(
      `${this.getName()} usable=${this.maxUsableRam(ns)} type=${type} script=${
        Scripts[type]
      } scriptRam=${ns.getScriptRam(Scripts[type], this.getName())}`,
    );
    */
    return Math.floor(this.maxUsableRam(ns) / ns.getScriptRam(Scripts[type], this.getName()));
  }

  async deploy(ns: NS): Promise<boolean> {
    return await ns.scp(Object.values(Scripts), this.name);
  }
}

export class Executor {
  private hosts: Host[] = [];

  getAvailableThreads(ns: NS, type: JobType): number {
    return this.hosts.map(h => h.getAvailableThreads(ns, type)).reduce((a, b) => a + b, 0);
  }

  getMaximumThreads(ns: NS, type: JobType): number {
    return this.hosts.map(h => h.getMaximumThreads(ns, type)).reduce((a, b) => a + b, 0);
  }

  equivalentThreads(ns: NS, n: number, from: JobType, to: JobType): number {
    return equivalentThreads(ns, n, from, to);
  }

  countThreads(target: string, type: JobType): number {
    return this.hosts.map(h => h.countThreads(target, type)).reduce((a, b) => a + b, 0);
  }

  countThreadsByType(type: JobType): number {
    return this.hosts.map(h => h.countThreadsByType(type)).reduce((a, b) => a + b, 0);
  }

  countAllThreadsHackEquivalent(ns: NS): number {
    return this.hosts.map(h => h.countAllThreadsHackEquivalent(ns)).reduce((a, b) => a + b, 0);
  }

  // Returns all finished workers, and discovers any new hosts / workers
  async update(ns: NS): Promise<Result[]> {
    // Discover any new hosts
    const hackedHostnames = discoverHackedHosts(ns);
    for (const hostname of hackedHostnames) {
      if (!this.hosts.find(h => h.getName() === hostname)) {
        if (ns.getServerMaxRam(hostname) === 0) {
          continue;
        }
        const host = new Host(hostname);
        await host.deploy(ns);

        this.hosts = this.hosts.filter(h => h.getName() !== hostname);
        this.hosts.push(host);
        ns.print(`Discovered new host: ${hostname} with ${ns.getServerMaxRam(hostname)}GB RAM, deployed scripts`);
      }
    }

    // Find all finished workers
    // This _should_ handle "gone" hosts correctly
    const results = [];
    for (const host of this.hosts) {
      results.push(...(await host.update(ns)));
    }

    // Drop any gone hosts
    this.hosts = this.hosts.filter(h => hackedHostnames.includes(h.getName()));

    // Aaand done
    return results;
  }

  hostDeleted(hostname: string): void {
    this.hosts = this.hosts.filter(h => h.getName() !== hostname);
  }

  async exec(ns: NS, target: string, type: JobType, threads: number): Promise<number> {
    this.hosts.sort((a, b) => b.getAvailableThreads(ns, type) - a.getAvailableThreads(ns, type));

    let started = 0;
    for (const host of this.hosts) {
      // home has increased effectiveness for Grow and Weaken jobs, reserve it for those
      if (host.getName() === 'home' && type !== JobType.Grow && type !== JobType.Weaken) {
        continue;
      }
      if (started >= threads) {
        return started;
      }
      const available = host.getAvailableThreads(ns, type);
      if (available > 0) {
        const toExec = Math.min(available, threads - started);
        //ns.print(`Executing ${toExec} ${type} threads on ${host.getName()}`);
        if (host.exec(ns, target, type, toExec)) {
          started += toExec;
        } else {
          ns.print(`Failed to start ${toExec} ${type} threads on ${host.getName()}`);
        }
        await ns.asleep(0);
      }
    }

    ns.print(`Failed to start ${threads} ${type} threads: got only ${started}`);
    return started;
  }
}
