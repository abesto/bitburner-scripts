import { NS } from '@ns';

type When = number | (() => number);

interface Task {
  when: When;
  what: () => Promise<void>;
  name?: string;
}

function when(t: Task): number {
  if (typeof t.when === 'function') {
    return t.when();
  }
  return t.when;
}

function fromNow(when: When): When {
  const now = new Date().getTime();
  if (typeof when === 'function') {
    return () => now + when();
  }
  return now + when;
}

export class Scheduler {
  tasks: Task[] = [];

  constructor(private ns: NS) {}

  private cancel(task: Task): void {
    const index = this.tasks.indexOf(task);
    if (index !== -1) {
      this.tasks.splice(index, 1);
    }
  }

  async run(): Promise<number> {
    this.tasks.sort((a, b) => when(a) - when(b));
    for (const task of this.tasks) {
      if (when(task) > Date.now()) {
        break;
      }
      const name = task.name || task.what?.name;
      const start = Date.now();
      //this.ns.tprint(`Running ${name}...`);
      await task.what();
      const duration = Date.now() - start;
      if (duration > 50) {
        this.ns.print(`[scheduler] Finished ${name} in ${Math.round(Date.now() - start)}ms`);
      }
      //this.ns.tprint(`[scheduler] Finished ${name} in ${duration}ms`);
      this.cancel(task);
      await this.ns.asleep(0);
    }
    const next = Math.min(...this.tasks.map(t => when(t)));
    if (next === undefined) {
      throw new Error('Scheduler is empty, did you forget to register an infinite ticker? (See setInterval)');
    }
    const timeToSleep = next - Date.now();
    if (timeToSleep > 1000) {
      this.ns.print(`Scheduler will run again in ${Math.round(timeToSleep / 1000)}s`);
    }
    return timeToSleep;
  }

  schedule(task: Task): () => void {
    task.when = fromNow(task.when);
    const insertBefore = this.tasks.findIndex(t => when(t) > when(task));
    this.tasks.splice(insertBefore, 0, task);
    return () => this.cancel(task);
  }

  setTimeout(what: () => Promise<void>, when: When): () => void {
    return this.schedule({ when, what });
  }
}
