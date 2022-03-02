import { NS, ProcessInfo } from '@ns';

import { AutohackContext } from 'lib/autohack/context';
import { discoverHackedHosts } from 'lib/distributed';

export enum JobType {
  Hack = 'hack',
  Grow = 'grow',
  Weaken = 'weaken',
}

type JT = JobType;
const JT = JobType;

export interface Result {
  target: string;
  type: JT;
  threads: number;
  duration: number;
  impact: number;
}

export const scriptDir = '/bin/autohack/executor_scripts';

export const Scripts = {
  [JT.Hack]: `${scriptDir}/hack.js`,
  [JT.Grow]: `${scriptDir}/grow.js`,
  [JT.Weaken]: `${scriptDir}/weaken.js`,
};

const ScriptToJT = {
  [Scripts[JT.Hack]]: JT.Hack,
  [Scripts[JT.Grow]]: JT.Grow,
  [Scripts[JT.Weaken]]: JT.Weaken,
};

function equivalentThreads(ns: NS, n: number, from: JT, to: JT): number {
  const fromRam = ns.getScriptRam(Scripts[from], ns.getHostname());
  const toRam = ns.getScriptRam(Scripts[to], ns.getHostname());
  return Math.floor(n * (toRam / fromRam));
}

class Worker {
  constructor(
    readonly ns: NS,
    readonly host: Host,
    readonly target: string,
    readonly type: JT,
    readonly threads: number,
    readonly pid: number,
    readonly expectedEnd: number, // ms
    readonly random: number,
  ) {}

  get isRunning(): boolean {
    return this.ns.isRunning(this.pid, this.host.name);
  }

  async kill(): Promise<boolean> {
    if (!this.isRunning) {
      return false;
    }
    const success = await this.ns.kill(this.pid);
    if (!success) {
      this.ns.print(`${this.host.name} failed to kill ${this.type} ${this.pid}`);
      for (const p of this.ns.ps(this.host.name)) {
        this.ns.print(`${p.pid} ${p.filename} ${p.args}`);
      }
    }
    return success;
  }
}

function binarySearch<T, V>(arr: T[], compare: (a: T, b: V) => number, target: V): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const cmp = compare(arr[mid], target);
    if (cmp < 0) {
      lo = mid + 1;
    } else if (cmp > 0) {
      hi = mid - 1;
    } else {
      return mid;
    }
  }
  return -1;
}

function binaryInsert<T>(arr: T[], item: T, compare: (a: T, b: T) => number): void {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const cmp = compare(arr[mid], item);
    if (cmp < 0) {
      lo = mid + 1;
    } else if (cmp > 0) {
      hi = mid - 1;
    } else {
      return;
    }
  }
  arr.splice(lo, 0, item);
}

class Workers extends Map<number, Worker> {
  private workersInFinishingOrder: Worker[] = [];

  set(key: number, w: Worker): this {
    super.set(w.pid, w);
    binaryInsert(this.workersInFinishingOrder, w, (a, b) => a.expectedEnd - b.expectedEnd);
    return this;
  }

  delete(key: number): boolean {
    const worker = this.get(key);
    if (worker) {
      const i = binarySearch(
        this.workersInFinishingOrder,
        (mid, target) => mid.expectedEnd - target.expectedEnd,
        worker,
      );
      this.workersInFinishingOrder.splice(i, 1);
    }
    return super.delete(key);
  }

  values(): IterableIterator<Worker> {
    // Iteration is in order sorted by when the worker is expected to finish
    return this.workersInFinishingOrder.values();
  }

  entries(): IterableIterator<[number, Worker]> {
    throw new Error('Method not implemented.');
  }
}

class Host {
  scriptRam: { [script: string]: number } = {};
  workers: Workers = new Workers();

  constructor(private ctx: AutohackContext, readonly name: string) {
    for (const script of Object.keys(Scripts)) {
      this.scriptRam[script] = ctx.ns.getScriptRam(Scripts[script as keyof typeof Scripts], name);
    }
  }

  private get ns(): NS {
    return this.ctx.ns;
  }

  private get timeEpsilon(): number {
    return this.ctx.config.timeEpsilon;
  }

  private almostEquals(a: number, b: number): boolean {
    return this.ctx.formulas.almostEquals(a, b, this.timeEpsilon);
  }

  countThreads(target: string, type: JT): number {
    let threads = 0;
    for (const worker of this.workers.values()) {
      if (worker.target === target && worker.type === type) {
        threads += worker.threads;
      }
    }
    return threads;
  }

  countThreadsByType(type: JT): number {
    let threads = 0;
    for (const worker of this.workers.values()) {
      if (worker.type === type) {
        threads += worker.threads;
      }
    }
    return threads;
  }

  countAllThreadsHackEquivalent(): number {
    let threads = 0;
    for (const worker of this.workers.values()) {
      if (worker.type !== JT.Hack) {
        threads += equivalentThreads(this.ns, worker.threads, worker.type, JT.Hack);
      } else {
        threads += worker.threads;
      }
    }
    return threads;
  }

  findWorkersEndingAlmostSimultaneously(anchor: Worker): Worker[] {
    const relevantWorkers = [];
    for (const worker of this.workers.values()) {
      if (worker.type === anchor.type && worker.target === anchor.target) {
        relevantWorkers.push(worker);
      }
    }

    const anchorIndex = relevantWorkers.findIndex(w => w === anchor);
    const queue = [anchorIndex - 1, anchorIndex + 1];
    const seen = new Set<number>([anchorIndex]);
    const matched = [relevantWorkers[anchorIndex]];
    while (queue.length > 0) {
      const index = queue.shift();
      if (index === undefined) {
        break;
      }
      if (seen.has(index) || index < 0 || index >= relevantWorkers.length) {
        continue;
      }
      seen.add(index);
      const w = relevantWorkers[index];
      if (
        this.almostEquals(w.expectedEnd, matched[0].expectedEnd) ||
        this.almostEquals(w.expectedEnd, matched[matched.length - 1].expectedEnd)
      ) {
        matched.push(w);
        queue.push(index - 1, index + 1);
      }
    }
    return matched;
  }

  countThreadsFinishingAt(type: JT, target: string, time: number): { threads: number; when: number } | null {
    // Find ONE worker that matches the query
    const relevantWorkers = [];
    for (const worker of this.workers.values()) {
      if (worker.target === target && worker.type === type) {
        relevantWorkers.push(worker);
      }
    }
    const anchorIndex = relevantWorkers.findIndex(w => this.almostEquals(w.expectedEnd, time));
    if (anchorIndex === -1) {
      return null;
    }

    // Find all the others around it
    const matched = this.findWorkersEndingAlmostSimultaneously(relevantWorkers[anchorIndex]);

    // Tally time
    return {
      threads: matched.map(w => w.threads).reduce((a, b) => a + b, 0),
      when: Math.max(...matched.map(w => w.expectedEnd)),
    };
  }

  countThreadsFinishingBetween(type: JT, target: string, start: number, end: number): number {
    let threads = 0;
    for (const worker of this.workers.values()) {
      if (worker.target !== target || worker.type !== type || worker.expectedEnd < start) {
        continue;
      }
      if (worker.expectedEnd > end) {
        break;
      }
      threads += worker.threads;
    }
    return threads;
  }

  countThreadsFinishingJustBefore(type: JT, target: string, time: number): { threads: number; when: number } | null {
    let anchor = null;
    for (const w of this.workers.values()) {
      if (
        w.target === target &&
        w.type === type &&
        w.expectedEnd < time &&
        (anchor === null || w.expectedEnd > anchor.expectedEnd)
      ) {
        anchor = w;
      }
      if (w.expectedEnd > time) {
        break;
      }
    }

    if (anchor === null) {
      return null;
    }

    const matched = this.findWorkersEndingAlmostSimultaneously(anchor);
    return {
      threads: matched.map(w => w.threads).reduce((a, b) => a + b, 0),
      when: Math.max(...matched.map(w => w.expectedEnd)),
    };
  }

  countThreadsFinishingJustAfter(type: JT, target: string, time: number): { threads: number; when: number } | null {
    let anchor = null;
    // possible optimization: store an index by expected end time
    for (const w of this.workers.values()) {
      if (w.target === target && w.type === type && w.expectedEnd > time && anchor === null) {
        anchor = w;
        break;
      }
    }

    if (anchor === null) {
      return null;
    }

    const matched = this.findWorkersEndingAlmostSimultaneously(anchor);
    return {
      threads: matched.map(w => w.threads).reduce((a, b) => a + b, 0),
      when: Math.min(...matched.map(w => w.expectedEnd)),
    };
  }

  countThreadsFinishingJustAround(
    type: JT,
    target: string,
    time: number,
  ): { before: { threads: number; when: number } | null; after: { threads: number; when: number } | null } {
    return {
      before: this.countThreadsFinishingJustBefore(type, target, time),
      after: this.countThreadsFinishingJustAfter(type, target, time),
    };
  }

  async update(): Promise<Result[]> {
    const liveProcesses: { [pid: string]: ProcessInfo } = {};
    for (const p of this.ns.ps(this.name)) {
      if (!p.filename.startsWith(`${scriptDir}/`)) {
        continue;
      }
      liveProcesses[p.pid] = p;
      if (this.workers.has(p.pid)) {
        continue;
      }
      this.workers.set(
        p.pid,
        new Worker(
          this.ns,
          this,
          p.args[0],
          ScriptToJT[p.filename],
          p.threads,
          p.pid,
          parseFloat(p.args[1]),
          parseFloat(p.args[2]),
        ),
      );
    }

    const results: Result[] = [];
    for (const worker of this.workers.values()) {
      if (worker.pid in liveProcesses) {
        continue;
      }
      const filename = `/autohack/results/${worker.expectedEnd}-${worker.random}.txt`;
      if (!(this.name === this.ns.getHostname() || (await this.ns.scp(filename, this.name, this.ns.getHostname())))) {
        continue;
      }
      const workerDataStr = await this.ns.read(filename);
      if (workerDataStr !== '') {
        const result = {
          target: worker.target,
          type: worker.type,
          threads: worker.threads,
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
      this.ns.rm(filename);
      this.ns.rm(filename, this.name);
      this.workers.delete(worker.pid);
    }

    return results;
  }

  private jobTime(type: JT, target: string): number {
    if (type === JT.Hack) {
      return this.ctx.formulas.getHackTime(target);
    } else if (type === JT.Grow) {
      return this.ctx.formulas.getGrowTime(target);
    } else if (type === JT.Weaken) {
      return this.ctx.formulas.getWeakenTime(target);
    } else {
      throw new Error(`Unknown job type: ${type}`);
    }
  }

  exec(target: string, type: JT, threads: number): boolean {
    const now = new Date().getTime();
    const expectedEnd = now + this.jobTime(type, target);
    const random = Math.random();
    const pid = this.ns.exec(Scripts[type], this.name, threads, target, expectedEnd, random);
    if (pid === 0) {
      return false;
    }
    this.workers.set(pid, new Worker(this.ns, this, target, type, threads, pid, expectedEnd, random));
    return true;
  }

  async emergency(target: string): Promise<number> {
    let killed = 0;
    for (const worker of this.workers.values()) {
      if (
        worker.type === JT.Hack &&
        worker.expectedEnd < Date.now() + this.ctx.tickLength * 2 &&
        worker.target === target &&
        this.ns.isRunning(worker.pid, this.name)
      ) {
        if (await worker.kill()) {
          killed += worker.threads;
          this.workers.delete(worker.pid);
        }
      }
    }
    return killed;
  }

  private get maxUsableRam(): number {
    const ram = this.ns.getServerMaxRam(this.name);
    if (this.name === this.ns.getHostname()) {
      return ram - this.ctx.config.reservedRam;
    }
    return ram;
  }

  getScriptRam(type: JT): number {
    return this.scriptRam[type];
  }

  getAvailableThreads(type: JT): number {
    const free = this.maxUsableRam - this.ns.getServerUsedRam(this.name);
    return Math.floor(free / this.getScriptRam(type));
  }

  getMaximumThreads(type: JT): number {
    this.ctx.debug.Executor_GetMaximumThreads(
      `${this.name} usable=${this.maxUsableRam} type=${type} script=${Scripts[type]} scriptRam=${this.getScriptRam(
        type,
      )}`,
    );
    return Math.floor(this.maxUsableRam / this.getScriptRam(type));
  }

  async deploy(): Promise<boolean> {
    if (Object.values(Scripts).every(s => this.ns.fileExists(s, this.name))) {
      return true;
    }
    const retval = await this.ns.scp(Object.values(Scripts), this.name);
    await this.ns.asleep(0);
    for (const script of Object.keys(Scripts)) {
      this.scriptRam[script] = this.ns.getScriptRam(Scripts[script as keyof typeof Scripts], this.name);
    }
    return retval;
  }

  async killWorkers(type: JT | null): Promise<number> {
    let killed = 0;
    for (const worker of this.workers.values()) {
      if (type === null || worker.type === type) {
        if (await worker.kill()) {
          killed += worker.threads;
          this.workers.delete(worker.pid);
        }
      }
    }
    return killed;
  }
}

export class Executor {
  private hosts: Host[] = [];

  constructor(private ctx: AutohackContext) {}

  private get ns(): NS {
    return this.ctx.ns;
  }

  getAvailableThreads(type: JT): number {
    return this.hosts.map(h => h.getAvailableThreads(type)).reduce((a, b) => a + b, 0);
  }

  getMaximumThreads(type: JT): number {
    return this.hosts.map(h => h.getMaximumThreads(type)).reduce((a, b) => a + b, 0);
  }

  equivalentThreads(n: number, from: JT, to: JT): number {
    return equivalentThreads(this.ns, n, from, to);
  }

  countThreads(target: string, type: JT): number {
    return this.hosts.map(h => h.countThreads(target, type)).reduce((a, b) => a + b, 0);
  }

  countThreadsByType(type: JT): number {
    return this.hosts.map(h => h.countThreadsByType(type)).reduce((a, b) => a + b, 0);
  }

  countAllThreadsHackEquivalent(): number {
    return this.hosts.map(h => h.countAllThreadsHackEquivalent()).reduce((a, b) => a + b, 0);
  }

  countThreadsFinishingJustAround(
    type: JT,
    target: string,
    time: number,
  ): { before: { threads: number; when: number } | null; after: { threads: number; when: number } | null } {
    const anchors = this.hosts.flatMap(h => h.countThreadsFinishingJustAround(type, target, time));
    const before = anchors.flatMap(a => {
      const before = a.before;
      if (before === null) {
        return [];
      }
      return this.hosts.map(h => h.countThreadsFinishingAt(type, target, before.when));
    });
    const after = anchors.flatMap(a => {
      const after = a.after;
      if (after === null) {
        return [];
      }
      return this.hosts.map(h => h.countThreadsFinishingAt(type, target, after.when));
    });

    this.ctx.debug.Executor_future_Executor_countThreadsFinishingJustAround(
      this.ctx.fmt.keyValue(
        ['anchors', anchors.length.toString()],
        ['before', before.length.toString()],
        ['after', after.length.toString()],
      ),
    );

    return {
      before: before.reduce((a, b) => {
        if (a === null) {
          return b;
        }
        if (b === null) {
          return a;
        }
        return { threads: a.threads + b.threads, when: Math.max(a.when, b.when) };
      }, null),
      after: after.reduce((a, b) => {
        if (a === null) {
          return b;
        }
        if (b === null) {
          return a;
        }
        return { threads: a.threads + b.threads, when: Math.max(a.when, b.when) };
      }, null),
    };
  }

  countThreadsFinishingBetween(type: JT, target: string, start: number, end: number): number {
    return this.hosts.map(h => h.countThreadsFinishingBetween(type, target, start, end)).reduce((a, b) => a + b, 0);
  }

  countThreadsFinishingAt(type: JT, target: string, time: number): { threads: number; when: number } | null {
    return this.hosts
      .map(h => h.countThreadsFinishingAt(type, target, time))
      .reduce((a, b) => {
        if (a === null) {
          return b;
        }
        if (b === null) {
          return a;
        }
        return { threads: a.threads + b.threads, when: Math.max(a.when, b.when) };
      });
  }

  async emergency(target: string): Promise<number> {
    // Kill Hack workers finishing in the next 5 seconds
    let killed = 0;
    for (const host of this.hosts) {
      killed += await host.emergency(target);
    }
    if (killed > 0) {
      this.ctx.debug.Executor_emergency(`Killed ${killed} hack threads against ${target}`);
    }
    return killed;
  }

  // Returns all finished workers, and discovers any new hosts / workers
  async update(): Promise<Result[]> {
    // Discover any new hosts
    const hackedHostnames = discoverHackedHosts(this.ns);
    for (const hostname of hackedHostnames) {
      if (!this.hosts.find(h => h.name === hostname)) {
        if (this.ns.getServerMaxRam(hostname) === 0) {
          continue;
        }
        const host = new Host(this.ctx, hostname);
        await host.deploy();

        this.hosts = this.hosts.filter(h => h.name !== hostname);
        this.hosts.push(host);
        this.ns.print(
          `Discovered new host: ${hostname} with ${this.ns.getServerMaxRam(hostname)}GB RAM, deployed scripts`,
        );
      }
    }

    // Find all finished workers
    // This _should_ handle "gone" hosts correctly
    const results = [];
    for (const host of this.hosts) {
      results.push(...(await host.update()));
    }

    // Drop any gone hosts
    this.hosts = this.hosts.filter(h => hackedHostnames.includes(h.name));

    // Aaand done
    return results;
  }

  hostDeleted(hostname: string): void {
    this.hosts = this.hosts.filter(h => h.name !== hostname);
  }

  async exec(target: string, type: JT, threads: number): Promise<number> {
    this.hosts.sort((a, b) => b.getAvailableThreads(type) - a.getAvailableThreads(type));

    // home has increased effectiveness for Grow and Weaken jobs, prefer it for those
    if (type === JT.Hack) {
      const homeIndex = this.hosts.findIndex((h: Host) => h.name === 'home');
      const [home] = this.hosts.splice(homeIndex, 1);
      this.hosts.push(home);
    }

    let started = 0;
    for (const host of this.hosts) {
      if (started >= threads) {
        return started;
      }
      const available = host.getAvailableThreads(type);
      if (available > 0) {
        const toExec = Math.min(available, threads - started);
        // We could check if this is a grow / weaken job about to be executed oh home, and decrease the number of
        // threads according to the available cores. But: I'll take this extra safety layer, capacity is cheap after all.
        //ns.print(`Executing ${toExec} ${type} threads on ${host.getName()}`);
        if (host.exec(target, type, toExec)) {
          started += toExec;
        } else {
          this.ns.print(`Failed to start ${toExec} ${type} threads on ${host.name}`);
          this.ns.print(
            this.ctx.fmt.keyValue(
              ['available', available.toString()],
              ['toExec', toExec.toString()],
              ['freeRam', (this.ns.getServerMaxRam(host.name) - this.ns.getServerUsedRam(host.name)).toString()],
            ),
          );
        }
        await this.ns.asleep(0);
      }
    }

    if (started < threads) {
      this.ctx.debug.Executor_notEnoughThreads(`Failed to start ${threads} ${type} threads: got only ${started}`);
    }
    return started;
  }

  async execUpTo(target: string, type: JT, threads: number): Promise<number> {
    const current = this.countThreads(target, type);
    return await this.exec(target, type, Math.min(threads - current));
  }

  async killWorkers(type: JT | null = null, target: string | null = null): Promise<number> {
    let killed = 0;
    for (const host of this.hosts) {
      if (target === null || host.name === target) {
        killed += await host.killWorkers(type);
      }
    }
    if (killed > 0) {
      this.ns.print(`Killed ${killed} workers (type=${type} target=${target})`);
    }
    await this.ns.asleep(0);
    return killed;
  }

  async capWorkers(type: JT, target: string, cap: number, from: number, until: number): Promise<void> {
    const workers = this.hosts.flatMap(h =>
      [...h.workers.values()].filter(
        w => w.type === type && w.target === target && w.expectedEnd >= from && w.expectedEnd <= until,
      ),
    );
    workers.sort((a, b) => a.threads - b.threads);

    const running = workers.reduce((a, b) => a + b.threads, 0);
    const toKill = Math.max(0, running - cap);
    if (toKill <= 0) {
      return;
    }

    let killed = 0;
    while (killed < toKill && workers.length > 0) {
      const worker = workers.shift();
      if ((await worker?.kill()) || false) {
        killed += worker?.threads || 0;
      }
    }
    if (killed > 0) {
      this.ns.print(`Capped ${type} workers on ${target} from ${running} to ${running - killed} (killed ${killed})`);
    }
  }

  async killWorkersOnHost(host: string, type: JT | null = null): Promise<number> {
    const hostObj = this.hosts.find(h => h.name === host);
    if (hostObj) {
      return await hostObj.killWorkers(type);
    }
    return 0;
  }

  get utilization(): number {
    return this.countAllThreadsHackEquivalent() / this.getMaximumThreads(JT.Hack);
  }
}
