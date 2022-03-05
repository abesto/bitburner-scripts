import { Config } from 'lib/autohack/config';
import { AutohackContext } from 'lib/autohack/context';
import { Executor, JobType, Result } from 'lib/autohack/executor';
import { Statemachine } from 'lib/autohack/statemachine';
import { Stats } from 'lib/autohack/stats';
import { Formulas } from 'lib/formulas';

export class HackOneServer {
  private stats: Stats;
  readonly statemachine: Statemachine;
  private tickLengthExp = 0;
  private ticks = Number.MAX_VALUE;

  constructor(private ctx: AutohackContext, readonly target: string) {
    this.stats = new Stats(ctx, this);
    this.statemachine = new Statemachine(ctx, target);
    ctx.aggStats.addStats(this.stats);
  }

  increaseTickLength(): void {
    if (this.canIncreaseTickLength) {
      this.tickLengthExp += 1;
      this.stats.tickLength = this.tickLength;
    }
  }

  decreaseTickLength(): void {
    if (this.canDecreaseTickLength) {
      this.tickLengthExp -= 1;
      this.stats.tickLength = this.tickLength;
    }
  }

  get canDecreaseTickLength(): boolean {
    return this.tickLengthExp > 0;
  }

  private get tickLengthMultiplier(): number {
    return this.getTickLengthMultiplier();
  }

  private getTickLengthMultiplier(exp: number | null = null): number {
    return Math.pow(2, exp || this.tickLengthExp);
  }

  resetTickLength(): void {
    this.tickLengthExp = 0;
    this.stats.tickLength = this.tickLength;
  }

  getTickLength(exp: number | null = null): number {
    return this.ctx.config.baseTickLength * this.getTickLengthMultiplier(exp);
  }

  get tickLength(): number {
    return this.getTickLength();
  }

  get canIncreaseTickLength(): boolean {
    return this.getTickLength(this.tickLengthExp + 1) < this.ctx.formulas.getWeakenTime(this.target);
  }

  private get formulas(): Formulas {
    return this.ctx.formulas;
  }

  private get config(): Config {
    return this.ctx.config;
  }

  private get executor(): Executor {
    return this.ctx.executor;
  }

  async shutdown(): Promise<void> {
    await this.executor.killWorkers(JobType.Hack, this.target);
    await this.executor.killWorkers(JobType.Grow, this.target);
    await this.executor.killWorkers(JobType.Weaken, this.target);
  }

  async tick(): Promise<void> {
    this.ticks += 1;
    if (this.ticks < this.tickLengthMultiplier) {
      return;
    }
    this.ticks = 0;
    if (this.ctx.ns.getServerMoneyAvailable(this.target) === 0) {
      this.ctx.ns.print(`Uh-oh, no money left on ${this.target}`);
    }
    await this.statemachine.tick();
    if (this.formulas.moneyRatio(this.target) < this.config.emergencyShutdownMoneyRatio) {
      await this.executor.emergency(this.target);
    }
  }

  handleResults(results: Result[]): void {
    this.stats.handleResults(results);
  }
}
