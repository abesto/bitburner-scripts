import { NS } from '@ns';

import { Config } from 'lib/autohack/config';
import { AutohackContext } from 'lib/autohack/context';
import { JobType, Result } from 'lib/autohack/executor';
import { AutohackSchedulerUserData } from 'lib/autohack/statemachine';
import { HackOneServer } from 'lib/autohack/targeting';
import { Fmt } from 'lib/fmt';

class JobTypeStats {
  inProgressHistory: number[] = [];
  queuedHistory: number[] = [];
  finished = 0;
  duration = 0;
  impact = 0;

  reset() {
    this.inProgressHistory = [];
    this.queuedHistory = [];
    this.finished = 0;
    this.duration = 0;
    this.impact = 0;
  }
}

export class Stats {
  private hacks = new JobTypeStats();
  private grows = new JobTypeStats();
  private weakens = new JobTypeStats();

  private hackCapacityHistory: number[] = [];
  private moneyRatioHistory: number[] = [];
  private securityLevelHistory: number[] = [];

  tickLength: number;
  readonly target: string;
  private lastPrintAt = Date.now();

  constructor(private ctx: AutohackContext, private hack: HackOneServer) {
    this.tickLength = ctx.tickLength;
    this.target = hack.target;
  }

  get isSteadyState(): boolean {
    return this.hack.statemachine.isSteadyState;
  }

  private get ns(): NS {
    return this.ctx.ns;
  }

  private get cfg(): Config {
    return this.ctx.config;
  }

  private get fmt(): Fmt {
    return this.ctx.fmt;
  }

  private get time(): number {
    return this.lastPrintAt - Date.now();
  }

  async tick(): Promise<boolean> {
    this.recordServerState();
    this.recordExecutorState();
    this.recordSchedulerState();
    if (this.time >= this.cfg.statsPeriod) {
      return true;
    }
    return false;
  }

  private recordServerState() {
    const server = this.target;
    this.moneyRatioHistory.push(this.ns.getServerMoneyAvailable(server) / this.ns.getServerMaxMoney(server));
    this.securityLevelHistory.push(this.ns.getServerSecurityLevel(server));
  }

  private recordExecutorState() {
    this.grows.inProgressHistory.push(this.ctx.executor.countThreads(this.target, JobType.Grow));
    this.hacks.inProgressHistory.push(this.ctx.executor.countThreads(this.target, JobType.Hack));
    this.weakens.inProgressHistory.push(this.ctx.executor.countThreads(this.target, JobType.Weaken));
    this.hackCapacityHistory.push(this.ctx.executor.getMaximumThreads(JobType.Hack));
  }

  private recordSchedulerState() {
    let grows = 0;
    let weakens = 0;
    let hacks = 0;
    for (const task of this.ctx.scheduler.tasks) {
      const userData = task.userData as AutohackSchedulerUserData;
      if (userData?.__tag !== 'AutohackSchedulerUserData') {
        continue;
      }
      if (userData.target !== this.target) {
        continue;
      }
      if (userData.jobType === JobType.Grow) {
        grows += userData.threads;
      } else if (userData.jobType === JobType.Weaken) {
        weakens += userData.threads;
      } else if (userData.jobType === JobType.Hack) {
        hacks += userData.threads;
      } else {
        throw new Error(`Unknown job type ${userData.jobType}`);
      }
    }
    this.grows.queuedHistory.push(grows);
    this.weakens.queuedHistory.push(weakens);
    this.hacks.queuedHistory.push(hacks);
  }

  reset(): void {
    this.hacks.reset();
    this.grows.reset();
    this.weakens.reset();
    this.lastPrintAt = Date.now();
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

  private formatHistoryAvg(history: number[]): string {
    const sum = history.reduce((a, b) => a + b, 0);
    const avg = Math.round(sum / history.length);
    //return `${Math.min(...history)},${avg},${Math.max(...history)}`;
    return avg.toString();
  }

  shortFields(): string[] {
    return [
      this.target,
      // tick length
      this.tickLength.toString(),
      // weaken time
      this.ctx.formulas.getWeakenTime(this.target).toString(),
      // money gained
      this.fmt.money(this.hacks.impact),
      // security over minimum
      this.fmt.float(
        this.securityLevelHistory.reduce((a, b) => a + b, 0) / this.securityLevelHistory.length -
          this.ns.getServerMinSecurityLevel(this.target),
      ),
      // hacks queued/in-flight/done
      `${this.formatHistoryAvg(this.hacks.queuedHistory)}/${this.formatHistoryAvg(this.hacks.inProgressHistory)}/${
        this.hacks.finished
      }`,
      // grows queued/in-flight/done
      `${this.formatHistoryAvg(this.grows.queuedHistory)}/${this.formatHistoryAvg(this.grows.inProgressHistory)}/${
        this.grows.finished
      }`,
      // weakens queued/in-flight/done
      `${this.formatHistoryAvg(this.weakens.queuedHistory)}/${this.formatHistoryAvg(this.weakens.inProgressHistory)}/${
        this.weakens.finished
      }`,
    ];
  }

  print(): void {
    this.ns.print(`== Stats at ${new Date()} after ${this.fmt.time(this.time)} target:${this.target} ==`);

    const lines = this.fmt.keyValueTabulated(
      [
        'money-ratio',
        ['min', this.fmt.float(Math.min(...this.moneyRatioHistory))],
        ['max', this.fmt.float(Math.max(...this.moneyRatioHistory))],
        ['avg', this.fmt.float(this.moneyRatioHistory.reduce((a, b) => a + b, 0) / this.moneyRatioHistory.length)],
        ['target', this.fmt.float(this.cfg.targetMoneyRatio)],
      ],
      [
        'security',
        ['min', this.fmt.float(Math.min(...this.securityLevelHistory))],
        ['max', this.fmt.float(Math.max(...this.securityLevelHistory))],
        [
          'avg',
          this.fmt.float(this.securityLevelHistory.reduce((a, b) => a + b, 0) / this.securityLevelHistory.length),
        ],
        ['target', this.fmt.float(this.ns.getServerMinSecurityLevel(this.target))],
      ],
      [
        'hacks',
        ['proc', this.formatHistoryAvg(this.hacks.inProgressHistory)],
        ['done', this.hacks.finished.toString()],
        ['money', this.fmt.money(this.hacks.impact)],
        ['per-sec', this.fmt.money(this.hacks.impact / (this.time / 1000))],
      ],
      [
        'grows',
        ['proc', this.formatHistoryAvg(this.grows.inProgressHistory)],
        ['done', this.grows.finished.toString()],
        ['amount', this.fmt.float(this.grows.impact)],
      ],
      [
        'weakens',
        ['proc', this.formatHistoryAvg(this.weakens.inProgressHistory)],
        ['done', this.weakens.finished.toString()],
        ['amount', this.fmt.float(this.weakens.impact)],
      ],
    );
    for (const line of lines) {
      this.ns.print(line);
    }
  }
}

export class AggStats {
  stats: Stats[] = [];
  lifetimeMoney = 0;
  lifetime = 0;
  lastMinuteMoney: { money: number; time: number }[] = [];
  time = 0;

  constructor(private ctx: AutohackContext) {}

  private get ns(): NS {
    return this.ctx.ns;
  }

  private get cfg(): Config {
    return this.ctx.config;
  }

  private get fmt(): Fmt {
    return this.ctx.fmt;
  }

  addStats(stats: Stats): void {
    this.stats.push(stats);
  }

  async tick(): Promise<boolean> {
    for (const stats of this.stats) {
      await stats.tick();
    }
    this.time += this.ctx.tickLength;
    this.lifetime += this.ctx.tickLength;
    if (this.time >= this.cfg.statsPeriod) {
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
    const rows = this.stats
      .filter(s => s.isSteadyState)
      .map(s => s.shortFields())
      .filter(r => !r.slice(5, 8).includes('0/0/0'));
    rows.sort((a, b) => parseInt(a[2]) - parseInt(b[2]));
    const money = rows.map(r => this.fmt.parseMoney(r[3])).reduce((a, b) => a + b, 0);
    this.lifetimeMoney += money;
    const now = Date.now();
    this.lastMinuteMoney.push({ money, time: now });
    this.lastMinuteMoney = this.lastMinuteMoney.filter(m => m.time > now - 60 * 1000);
    this.ns.print(`== Stats at ${new Date()} after ${this.fmt.time(this.time)} ==`);
    const aggHistory = (field: number) =>
      rows
        .map(r => r[field].split('/').map(n => parseInt(n)))
        .reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], [0, 0, 0])
        .map(n => this.fmt.intShort(n))
        .join('/');
    const totals = [
      'TOTAL/AVG',
      this.fmt.float(rows.map(r => parseFloat(r[1])).reduce((a, b) => a + b, 0) / rows.length),
      this.fmt.timeShort(rows.map(r => parseFloat(r[2])).reduce((a, b) => a + b, 0) / rows.length),
      this.fmt.money(money),
      this.fmt.float(rows.map(r => parseFloat(r[4])).reduce((a, b) => a + b, 0)),
      aggHistory(5),
      aggHistory(6),
      aggHistory(7),
    ];

    const fmtHistory = (s: string) =>
      s
        .split('/')
        .map(n => this.fmt.intShort(parseInt(n)))
        .join('/');
    for (const row of rows) {
      row[2] = this.fmt.timeShort(parseFloat(row[2]));
      row[5] = fmtHistory(row[5]);
      row[6] = fmtHistory(row[6]);
      row[7] = fmtHistory(row[7]);
    }
    for (const line of this.fmt.table(
      ['TARGET', 'TICK-LENGTH', 'WEAKEN-TIME', 'GAIN', 'SEC-OVER', 'HACKS', 'GROWS', 'WEAKENS'],
      ...rows,
      totals,
    )) {
      this.ns.print(line);
    }
    this.ns.print(
      this.fmt.keyValue(
        ['util', this.fmt.float(this.ctx.executor.utilization)],
        ['money/sec', this.fmt.money(this.lifetimeMoney / (this.lifetime / 1000))],
        [
          'money/sec@1min',
          this.fmt.money(this.lastMinuteMoney.reduce((a, b) => a + b.money, 0) / Math.min(60, this.lifetime / 1000)),
        ],
        ['max-grows', this.fmt.intShort(this.ctx.executor.getMaximumThreads(JobType.Grow))],
        [
          'initial-grow',
          this.stats
            .filter(s => !s.isSteadyState)
            .map(s => s.target)
            .join(', '),
        ],
      ),
    );
  }
}
