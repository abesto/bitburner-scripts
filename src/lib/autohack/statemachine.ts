import { Debug } from '/lib/debug';

import { NS } from '@ns';

import { Config } from 'lib/autohack/config';
import { AutohackContext } from 'lib/autohack/context';
import { Executor, JobType } from 'lib/autohack/executor';
import { Formulas } from 'lib/formulas';
import { Scheduler } from 'lib/scheduler';

enum State {
  InitialGrow,
  Hacking,
}

export interface AutohackSchedulerUserData {
  target: string;
  jobType: JobType;
  threads: number;
  __tag: 'AutohackSchedulerUserData';
}

export class Statemachine {
  private state: State;
  private dbg: Debug;

  constructor(private ctx: AutohackContext, private target: string) {
    this.dbg = this.ctx.debug.withCategoryPrefix(`Statemachine_${target}`);
    if (this.fm.moneyRatio(this.target) < this.cfg.targetMoneyRatio ** 2) {
      this.state = State.InitialGrow;
    } else {
      this.state = State.Hacking;
    }
    this.dbg.Transition(`Booting into ${this.state}`);
  }

  get isSteadyState(): boolean {
    return this.state === State.Hacking;
  }

  private get ns(): NS {
    return this.ctx.ns;
  }

  private get cfg(): Config {
    return this.ctx.config;
  }

  private get fm(): Formulas {
    return this.ctx.formulas;
  }

  private get executor(): Executor {
    return this.ctx.executor;
  }

  private get scheduler(): Scheduler {
    return this.ctx.scheduler;
  }

  async tick(): Promise<void> {
    switch (this.state) {
      case State.InitialGrow:
        await this.initialGrow();
        break;
      case State.Hacking:
        await this.hacking();
        break;
    }
  }

  private async initialGrow(): Promise<void> {
    // Grow until we're at the target money ratio.
    if (
      this.fm.moneyRatio(this.target) < 1 ||
      this.ns.getServerSecurityLevel(this.target) > this.ns.getServerMinSecurityLevel(this.target)
    ) {
      const weakenBefore = this.fm.weakenToMinimum(this.target);
      const weakenBeforeFinishesIn = this.fm.getWeakenTime(this.target);
      const growFinishesIn = weakenBeforeFinishesIn + this.cfg.timeEpsilon * 2;
      const grow = this.fm.growthToTargetMoneyRatio(this.target, 1);
      const weakenAfter = this.fm.weakenAfterGrows(grow);
      const weakenAfterFinishesIn = growFinishesIn + this.cfg.timeEpsilon * 2;

      await this.executor.execUpTo(this.target, JobType.Weaken, weakenBefore);

      this.scheduler.schedule({
        name: 'initial-grow',
        when: growFinishesIn - this.fm.getGrowTime(this.target),
        userData: {
          target: this.target,
          jobType: JobType.Grow,
          threads: grow,
          __tag: 'AutohackSchedulerUserData',
        },
        what: () => this.executor.execUpTo(this.target, JobType.Grow, grow),
      });

      this.scheduler.schedule({
        name: 'initial-weaken-after',
        when: weakenAfterFinishesIn - this.fm.getWeakenTime(this.target),
        userData: {
          target: this.target,
          jobType: JobType.Weaken,
          threads: weakenAfter,
          __tag: 'AutohackSchedulerUserData',
        },
        what: () => this.executor.execUpTo(this.target, JobType.Weaken, weakenAfter),
      });

      this.scheduler.schedule({
        name: 'initial-done',
        when: weakenAfterFinishesIn + this.cfg.timeEpsilon * 2,
        what: () => this.initialGrow(),
      });
    } else {
      this.state = State.Hacking;
      this.dbg.Transition(`Grow finished, switching to hacking`);
    }
  }

  private async scheduleWork(): Promise<void> {
    // Schedule, ending 2 * timeEpsilon from each other: hack, weaken, grow, weaken
    const target = this.target;
    const dbg = this.dbg.withCategoryPrefix('scheduleWork');
    const fmt = this.ctx.fmt;
    const fm = this.fm;

    const now = new Date().getTime();

    const hackWeakenWillFinishIn = fm.getWeakenTime(target);
    const growWillFinishIn = hackWeakenWillFinishIn + this.cfg.timeEpsilon * 2;
    const growWeakenWillFinishIn = growWillFinishIn + this.cfg.timeEpsilon * 2;
    const hackWillFinishIn = hackWeakenWillFinishIn - this.cfg.timeEpsilon * 2;

    const growWillFinishAt = now + growWillFinishIn;
    if (
      this.executor.countThreadsFinishingBetween(
        JobType.Hack,
        target,
        growWillFinishAt - this.ctx.tickLength / 2,
        growWillFinishAt + this.ctx.tickLength / 2,
      ) > 0
    ) {
      dbg.alreadyScheduled('Hacks already scheduled for the tick that grows started now would finish in');
      return;
    }

    // Add on some arbitrary multipliers because we hit the emergency stop often later in the game. Something somewhere
    // is incorrect, probably in formulas.ts, but for now this is a workaround.
    const hacksWanted = fm.hacksFromToMoneyRatio(target, 1, this.cfg.targetMoneyRatio);
    const hackWeakensWanted = fm.weakenAfterHacks(hacksWanted * 2);
    const growsWanted = fm.growthFromToMoneyRatio(
      target,
      this.cfg.targetMoneyRatio,
      2,
      this.ns.getServerMinSecurityLevel(target) + this.cfg.securityThreshold,
    );
    const growWeakensWanted = fm.weakenAfterGrows(growsWanted * 2);

    const trySchedule = async (type: JobType, threads: number): Promise<boolean> => {
      if (
        (type === JobType.Grow || type === JobType.Hack) &&
        this.ns.getServerSecurityLevel(target) > this.ns.getServerMinSecurityLevel(target) + this.cfg.securityThreshold
      ) {
        dbg.trySchedule_security(`Skipping ${type}: security level too high`);
        return false;
      }

      const available = this.executor.getAvailableThreads(type);
      if (available < threads) {
        dbg.notEnoughThreads(`Not enough ${type} threads available (${available} < ${threads})`);
        return false;
      }
      const started = await this.executor.exec(target, type, threads);
      if (started < threads) {
        dbg[`notEnough${type}`](`Tried to start ${threads} ${type}s, but only started ${started}`);
        return false;
      }
      return true;
    };

    // Schedule hack-weakens
    this.scheduler.schedule({
      name: 'start-hack-weakens',
      what: async () => {
        if (!(await trySchedule(JobType.Weaken, hackWeakensWanted))) {
          cancelHacks();
        }
      },
      when: hackWeakenWillFinishIn - fm.getWeakenTime(target),
      userData: {
        target,
        jobType: JobType.Weaken,
        threads: hackWeakensWanted,
        __tag: 'AutohackSchedulerUserData',
      },
    });

    // Schedule grows
    const startGrowsIn = growWillFinishIn - fm.getGrowTime(target);
    this.scheduler.schedule({
      name: 'start-grows',
      what: async () => {
        if (!(await trySchedule(JobType.Grow, growsWanted))) {
          cancelHacks();
        }
      },
      when: startGrowsIn,
      userData: {
        target,
        jobType: JobType.Grow,
        threads: growsWanted,
        __tag: 'AutohackSchedulerUserData',
      },
    });

    // Schedule grow-weakens
    this.scheduler.schedule({
      name: 'start-grow-weakens',
      what: async () => {
        if (!(await trySchedule(JobType.Weaken, growWeakensWanted))) {
          cancelHacks();
        }
      },
      when: growWeakenWillFinishIn - fm.getWeakenTime(target),
      userData: {
        target,
        jobType: JobType.Weaken,
        threads: growWeakensWanted,
        __tag: 'AutohackSchedulerUserData',
      },
    });

    // Schedule hacks
    const hackWillFinishAt = now + hackWillFinishIn;
    let cancelHacks = this.scheduler.schedule({
      name: 'start-hacks-wrapper',
      userData: {
        target,
        jobType: JobType.Hack,
        threads: hacksWanted,
        __tag: 'AutohackSchedulerUserData',
      },
      what: async () => {
        if (hacksWanted < 1) {
          dbg.noHacksNeeded(`hacksWanted=${hacksWanted}`);
          return;
        }

        const { before: growsBefore, after: growsAfter } = this.executor.countThreadsFinishingJustAround(
          JobType.Grow,
          target,
          hackWillFinishAt,
        );

        if (growsBefore === null && growsAfter === null) {
          dbg.noGrows(`Didn't find grows either before or after the hack finish time, so can't schedule hacks`);
        } else if (growsBefore === null && growsAfter !== null) {
          dbg.noGrowsBefore(
            `Didn't find grows before hack finish time; first grow after is in ${fmt.time(growsAfter.when - now)}`,
          );
        } else if (growsAfter === null && growsBefore !== null) {
          dbg.noGrowAfter(
            `Didn't find grows after hack finish time; last grow before is in ${fmt.time(growsBefore.when - now)}`,
          );
        }
        if (growsBefore === null || growsAfter === null) {
          return;
        }

        const startTime = growsAfter.when - Date.now() - 2 * this.cfg.timeEpsilon - fm.getHackTime(target);
        dbg.hacks(`Will start ${hacksWanted} hacks in ${fmt.time(startTime)}`);
        cancelHacks = this.scheduler.schedule({
          name: 'start-hacks',
          userData: {
            target,
            jobType: JobType.Hack,
            threads: hacksWanted,
            __tag: 'AutohackSchedulerUserData',
          },
          what: async () => {
            const hacksExist = this.executor.countThreadsFinishingBetween(
              JobType.Hack,
              target,
              growsBefore.when,
              growsAfter.when,
            );
            const toExec = hacksWanted - hacksExist;

            if (toExec <= 0) {
              await this.executor.capWorkers(JobType.Hack, target, hacksWanted, growsBefore.when, growsAfter.when);
            }

            if (toExec <= 0) {
              dbg.noHacksNeeded(`No hacks needed, ${hacksExist} hacks exist, ${hacksWanted} wanted`);
              return;
            }

            // All good, let's go
            dbg.hacks(
              fmt.keyValue(
                ['growsAfter', growsAfter.threads.toString()],
                ['hacksWanted', hacksWanted.toString()],
                ['hacksExist', hacksExist.toString()],
                ['toExec', toExec.toString()],
                ['startTime', fmt.time(startTime)],
              ),
            );
            await trySchedule(JobType.Hack, hacksWanted);
          },
          when: startTime,
        });
      },
      when: () => startGrowsIn + this.cfg.timeEpsilon,
    });
  }

  private async hacking(): Promise<void> {
    await this.scheduleWork();
  }
}
