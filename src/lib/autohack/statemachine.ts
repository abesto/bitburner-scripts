import { NS } from '@ns';

import { CONFIG, loadConfig } from 'lib/autohack/config';
import { DEBUG, initDebug } from 'lib/autohack/debug';
import { Executor, JobType } from 'lib/autohack/executor';
import { epsilon, timeEpsilon } from 'lib/constants';
import * as fmt from 'lib/fmt';
import * as fm from 'lib/formulas';
import { Scheduler } from 'lib/scheduler';

enum State {
  Startup,
  InitialGrow,
  Hacking,
}

export class Statemachine {
  private state: State = State.Startup;

  constructor(private ns: NS, private target: string, private executor: Executor, private scheduler: Scheduler) {
    initDebug(ns);
    fm.init(ns);
    fmt.init(ns);
    loadConfig(this.ns);
  }

  async tick(): Promise<void> {
    loadConfig(this.ns);
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
    if (fm.moneyRatio(this.target) < CONFIG.targetMoneyRatio ** 2) {
      this.state = State.InitialGrow;
    } else {
      this.state = State.Hacking;
    }
    DEBUG.Statemachine_Transition(`Booting into ${this.state}`);
    await this.tick();
  }

  private async initialGrow(): Promise<void> {
    // Grow until we're at the target money ratio.
    if (
      fm.moneyRatio(this.target) < 1 ||
      this.ns.getServerSecurityLevel(this.target) > this.ns.getServerMinSecurityLevel(this.target)
    ) {
      const grows = fm.growthToTargetMoneyRatio(this.target, 1);
      await this.executor.execUpTo(this.target, JobType.Grow, grows);
      await this.executor.execUpTo(
        this.target,
        JobType.Weaken,
        fm.weakenAfterGrows(grows) + fm.weakenToMinimum(this.target),
      );
    } else {
      this.state = State.Hacking;
      DEBUG.Statemachine_Transition('Initial grow complete, switching to hacking');
      await this.tick();
    }
  }

  private async scheduleWork(): Promise<void> {
    // Schedule, ending 2 * timeEpsilon from each other: hack, weaken, grow, weaken
    const target = this.target;

    const now = new Date().getTime();

    const hackWeakenWillFinishIn = fm.getWeakenTime(target);
    const growWillFinishIn = hackWeakenWillFinishIn + timeEpsilon * 2;
    const growWeakenWillFinishIn = growWillFinishIn + timeEpsilon * 2;
    const hackWillFinishIn = hackWeakenWillFinishIn - timeEpsilon * 2;

    const growWillFinishAt = now + growWillFinishIn;
    if (
      this.executor.countThreadsFinishingBetween(
        JobType.Hack,
        target,
        growWillFinishAt - CONFIG.tickLength / 2,
        growWillFinishAt + CONFIG.tickLength / 2,
      ) > 0
    ) {
      DEBUG.Statemachine_scheduleWork_alreadyScheduled(
        'Hacks already scheduled for the tick that grows started now would finish in',
      );
      return;
    }

    // Add on some arbitrary multipliers because we hit the emergency stop often later in the game. Something somewhere
    // is incorrect, probably in formulas.ts, but for now this is a workaround.
    const hacksWanted = fm.hacksFromToMoneyRatio(target, 1, CONFIG.targetMoneyRatio);
    const hackWeakensWanted = fm.weakenAfterHacks(hacksWanted * 2);
    const growsWanted = fm.growthFromToMoneyRatio(target, CONFIG.targetMoneyRatio, 2);
    const growWeakensWanted = fm.weakenAfterGrows(growsWanted * 2);

    const trySchedule = async (type: JobType, threads: number): Promise<boolean> => {
      if (
        (type === JobType.Grow || type === JobType.Hack) &&
        this.ns.getServerSecurityLevel(target) > this.ns.getServerMinSecurityLevel(target) + epsilon
      ) {
        DEBUG.Statemachine_trySchedule_security(`Skipping ${type}: security level too high`);
        return false;
      }

      const available = this.executor.getAvailableThreads(type);
      if (available < threads) {
        DEBUG.Statemachine_scheduleWork_notEnoughThreads(
          `Not enough ${type} threads available (${available} < ${threads})`,
        );
        return false;
      }
      const started = await this.executor.exec(target, type, threads);
      if (started < threads) {
        DEBUG[`Statemachine_scheduleWork_notEnough${type}`](
          `Tried to start ${threads} ${type}s, but only started ${started}`,
        );
        return false;
      }
      return true;
    };

    // Schedule hack-weakens
    await this.scheduler.schedule({
      name: 'start-hack-weakens',
      what: async () => {
        if (!(await trySchedule(JobType.Weaken, hackWeakensWanted))) {
          cancelHacks();
        }
      },
      when: () => hackWeakenWillFinishIn - fm.getWeakenTime(target),
    });

    // Schedule grows
    const startGrowsIn = growWillFinishIn - fm.getGrowTime(target);
    await this.scheduler.schedule({
      name: 'start-grows',
      what: async () => {
        if (!(await trySchedule(JobType.Grow, growsWanted))) {
          cancelHacks();
        }
      },
      when: () => startGrowsIn,
    });

    // Schedule grow-weakens
    await this.scheduler.schedule({
      name: 'start-grow-weakens',
      what: async () => {
        if (!(await trySchedule(JobType.Weaken, growWeakensWanted))) {
          cancelHacks();
        }
      },
      when: () => growWeakenWillFinishIn - fm.getWeakenTime(target),
    });

    // Schedule hacks
    const hackWillFinishAt = now + hackWillFinishIn;
    const cancelHacks = this.scheduler.schedule({
      name: 'start-hacks-wrapper',
      what: async () => {
        if (hacksWanted < 1) {
          DEBUG.Statemachine_scheduledWork_noHacksNeeded(`hacksWanted=${hacksWanted}`);
          return;
        }

        const { before: growsBefore, after: growsAfter } = this.executor.countThreadsFinishingJustAround(
          JobType.Grow,
          target,
          hackWillFinishAt,
        );

        if (growsBefore === null && growsAfter === null) {
          DEBUG.Statemachine_scheduleWork_noGrows(
            `Didn't find grows either before or after the hack finish time (in ${fmt.time(
              hackWillFinishIn,
            )}), so can't schedule hacks`,
          );
        } else if (growsBefore === null && growsAfter !== null) {
          DEBUG.Statemachine_scheduleWork_noGrowsBefore(
            `Didn't find grows before hack finish time; first grow after is in ${fmt.time(growsAfter.when - now)}`,
          );
        } else if (growsAfter === null && growsBefore !== null) {
          DEBUG.Statemachine_scheduleWork_noGrowsBefore(
            `Didn't find grows after hack finish time; last grow before is in ${fmt.time(growsBefore.when - now)}`,
          );
        }
        if (growsBefore === null || growsAfter === null) {
          return;
        }

        // Start the hack right in the middle of the two grows
        const startTime = Math.round((growsAfter.when - now + growsBefore.when - now) / 2);
        DEBUG.Statemachine_scheduleWork_hacks(`Will start ${hacksWanted} hacks in ${fmt.time(startTime)}`);
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
              DEBUG.Statemachine_scheduleWork_noHacksNeeded(
                `No hacks needed, ${hacksExist} hacks exist, ${hacksWanted} wanted`,
              );
              return;
            }

            // All good, let's go
            DEBUG.Statemachine_scheduleWork_hacks(
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
      when: () => startGrowsIn + timeEpsilon,
    });
  }

  private async emergencyStop(): Promise<void> {
    const moneyRatio = fm.moneyRatio(this.target);
    const threshold = 0.1;
    if (moneyRatio < threshold) {
      await this.executor.killWorkers(JobType.Hack);
      DEBUG.Statemachine_emergencyStop(`Emergency stop: money ratio is ${moneyRatio} (less than ${threshold})`);
    }
  }

  private async hacking(): Promise<void> {
    await this.scheduleWork();
  }
}
