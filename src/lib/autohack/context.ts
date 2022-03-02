import { NS } from '@ns';

import { Config, DEFAULT_CONFIG, loadConfig } from 'lib/autohack/config';
import { Debug } from 'lib/autohack/debug';
import { Executor } from 'lib/autohack/executor';
import { AggStats } from 'lib/autohack/stats';
import { Fmt } from 'lib/fmt';
import { Formulas } from 'lib/formulas';
import { Scheduler } from 'lib/scheduler';

export class AutohackContext {
  readonly config: Config = DEFAULT_CONFIG;

  readonly debug: Debug;
  readonly executor: Executor;
  readonly aggStats: AggStats;
  readonly fmt: Fmt;
  readonly formulas: Formulas;
  readonly scheduler: Scheduler;

  constructor(readonly ns: NS) {
    this.fmt = new Fmt(ns);
    this.formulas = new Formulas(ns);
    this.debug = Debug(this);
    this.executor = new Executor(this);
    this.aggStats = new AggStats(this);
    this.scheduler = new Scheduler(ns);
  }

  loadConfig(): void {
    const loaded = loadConfig(this.ns, this.fmt);
    if (loaded) {
      Object.assign(this.config, loaded);
    }
  }

  get tickLength(): number {
    return this.config.baseTickLength;
  }
}
