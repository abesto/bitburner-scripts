import { NS } from '@ns';

import { DEFAULT_CONFIG, loadConfig } from 'lib/autohack/config';
import { AutohackContext } from 'lib/autohack/context';
import { Executor, JobType } from 'lib/autohack/executor';
import { Fmt } from 'lib/fmt';
import { Formulas } from 'lib/formulas';

// For early game when we don't have enough capacity to run the full autohack
export async function main(ns: NS): Promise<void> {
  const target = ns.args[0] as string;
  ns.disableLog('asleep');
  ns.disableLog('getServerUsedRam');
  ns.disableLog('scan');

  const ctx = new AutohackContext(ns); // only here for executor.exec, could in theory reimplement that with minimal dependencies
  const fm = ctx.formulas;

  const executor = ctx.executor;

  async function waitForJobs(type: JobType): Promise<void> {
    while (executor.countThreads(target, type) > 0) {
      ctx.loadConfig();
      await ns.asleep(1000);
      await executor.update();
    }
  }

  async function weaken(): Promise<void> {
    while (ns.getServerSecurityLevel(target) > ns.getServerMinSecurityLevel(target)) {
      await executor.exec(target, JobType.Weaken, executor.getAvailableThreads(JobType.Weaken));
      await waitForJobs(JobType.Weaken);
    }
  }

  async function grow(): Promise<void> {
    while (ns.getServerMoneyAvailable(target) < ns.getServerMaxMoney(target)) {
      await executor.exec(target, JobType.Grow, executor.getAvailableThreads(JobType.Grow));
      await waitForJobs(JobType.Grow);
    }
  }

  async function hack(): Promise<void> {
    const want = fm.hacksFromToMoneyRatio(target, 1, ctx.config.targetMoneyRatio);
    await executor.exec(target, JobType.Hack, want);
    await waitForJobs(JobType.Hack);
  }

  while (true) {
    await executor.update();
    await weaken();
    await grow();
    await weaken();
    await hack();
  }
}
