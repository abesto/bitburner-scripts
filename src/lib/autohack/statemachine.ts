import { Debug } from '/lib/debug';

import { NS } from '@ns';

import { Config } from 'lib/autohack/config';
import { AutohackContext } from 'lib/autohack/context';
import { Executor, JobType } from 'lib/autohack/executor';
import { Formulas } from 'lib/formulas';
import { Scheduler } from 'lib/scheduler';

enum State {
  Startup,
  InitialGrow,
  Hacking,
}

export class Statemachine {
  private state: State = State.Startup;
  private dbg: Debug;

  constructor(private ctx: AutohackContext, private target: string) {
    this.dbg = this.ctx.debug.withCategoryPrefix(`Statemachine_${target}`);
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
      case State.Startup:
        await this.startup();
        break;
      case State.InitialGrow:
        await this.initialGrow();
        break;
      case State.Hacking:
        await this.hacking();
        break;
    }
  }

  private async startup(): Promise<void> {
    // Discover whether we're in the initial grow phase.
    if (this.fm.moneyRatio(this.target) < this.cfg.targetMoneyRatio ** 2) {
      this.state = State.InitialGrow;
    } else {
      this.state = State.Hacking;
    }
    this.dbg.Transition(`Booting into ${this.state}`);
    await this.tick();
  }

  private async initialGrow(): Promise<void> {
    // Grow until we're at the target money ratio.
    if (
      this.fm.moneyRatio(this.target) < 1 ||
      this.ns.getServerSecurityLevel(this.target) > this.ns.getServerMinSecurityLevel(this.target)
    ) {
      const grows = this.fm.growthToTargetMoneyRatio(this.target, 1);
      await this.executor.execUpTo(this.target, JobType.Grow, grows);
      await this.executor.execUpTo(
        this.target,
        JobType.Weaken,
        this.fm.weakenAfterGrows(grows) + this.fm.weakenToMinimum(this.target),
      );
    } else {
      this.state = State.Hacking;
      this.dbg.Transition('Initial grow complete, switching to hacking');
      await this.tick();
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
    });

    // Schedule hacks
    const hackWillFinishAt = now + hackWillFinishIn;
    const cancelHacks = this.scheduler.schedule({
      name: 'start-hacks-wrapper',
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
          dbg.noGrows(
            `Didn't find grows either before or after the hack finish time (in ${fmt.time(
              hackWillFinishIn,
            )}), so can't schedule hacks`,
          );
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
        this.scheduler.schedule({
          name: 'start-hacks',
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
