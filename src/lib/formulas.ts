import { NS } from '@ns';

export class Formulas {
  private lastFormulasCheck = 0;
  private _haveFormulas = false;

  constructor(private ns: NS) {}

  private get haveFormulas(): boolean {
    if (Date.now() - this.lastFormulasCheck > 1000) {
      this.lastFormulasCheck = Date.now();
      this._haveFormulas = this.ns.fileExists('Formulas.exe');
    }
    return this._haveFormulas;
  }

  moneyRatio(server: string): number {
    return this.ns.getServerMoneyAvailable(server) / this.ns.getServerMaxMoney(server);
  }

  growthForMoneyMultiplier(server: string, targetMultiplier: number, atSecurity: number | null = null): number {
    let threads = Math.ceil(this.ns.growthAnalyze(server, targetMultiplier));
    if (this.haveFormulas) {
      const serverObj = this.ns.getServer(server);
      const player = this.ns.getPlayer();
      serverObj.hackDifficulty = atSecurity || serverObj.minDifficulty;
      while (this.ns.formulas.hacking.growPercent(serverObj, threads, player) < targetMultiplier) {
        threads *= 1.01;
      }
    }
    return Math.ceil(threads);
  }

  growthToTargetMoneyRatio(server: string, targetMoneyRatio: number): number {
    const currentMoneyRatio = this.moneyRatio(server);
    const targetMultiplier = targetMoneyRatio / currentMoneyRatio;
    return this.growthForMoneyMultiplier(server, targetMultiplier);
  }

  growthFromToMoneyRatio(server: string, from: number, to: number, atSecurity: number | null = null): number {
    return this.growthForMoneyMultiplier(server, to / from, atSecurity);
  }

  almostEquals(a: number, b: number, epsilon: number): boolean {
    return Math.abs(a - b) < epsilon;
  }

  getBaseLog(base: number, x: number): number {
    return Math.log(x) / Math.log(base);
  }

  hacksFromToMoneyRatio(server: string, from: number, to: number): number {
    const targetPercent = from - to;
    if (this.haveFormulas) {
      const serverObj = this.ns.getServer(server);
      serverObj.hackDifficulty = serverObj.minDifficulty;
      const hackPercent = this.ns.formulas.hacking.hackPercent(serverObj, this.ns.getPlayer());
      return Math.ceil(targetPercent / hackPercent);
      //return Math.ceil(getBaseLog(1 - hackPercent, targetPercent));
    }
    const targetMoneyStolen = this.ns.getServerMaxMoney(server) * targetPercent;
    const threads = Math.floor(this.ns.hackAnalyzeThreads(server, targetMoneyStolen));
    return threads;
  }

  weakenForSecurityDecrease(security: number): number {
    // This makes the bold assumption that weakens are linear
    let threads = Math.ceil(security / this.ns.weakenAnalyze(1));
    // It seems to not work very well, and I can't find a much better way, so...
    while (this.ns.weakenAnalyze(threads) < security) {
      threads++;
    }
    return threads;
  }

  weakenToMinimum(server: string): number {
    return this.weakenForSecurityDecrease(
      this.ns.getServerSecurityLevel(server) - this.ns.getServerMinSecurityLevel(server),
    );
  }

  weakenAfterHacks(hacks: number): number {
    const security = this.ns.hackAnalyzeSecurity(hacks);
    return this.weakenForSecurityDecrease(security);
  }

  weakenAfterGrows(grows: number): number {
    const security = this.ns.growthAnalyzeSecurity(grows);
    return this.weakenForSecurityDecrease(security);
  }

  getWeakenTime(server: string): number {
    if (this.haveFormulas) {
      return this.ns.formulas.hacking.weakenTime(this.ns.getServer(server), this.ns.getPlayer());
    }
    return this.ns.getWeakenTime(server);
  }

  getHackTime(server: string): number {
    if (this.haveFormulas) {
      const serverObj = this.ns.getServer(server);
      serverObj.hackDifficulty = serverObj.minDifficulty;
      return this.ns.formulas.hacking.hackTime(serverObj, this.ns.getPlayer());
    }
    return this.ns.getHackTime(server);
  }

  getGrowTime(server: string): number {
    if (this.haveFormulas) {
      const serverObj = this.ns.getServer(server);
      serverObj.hackDifficulty = serverObj.minDifficulty;
      return this.ns.formulas.hacking.growTime(serverObj, this.ns.getPlayer());
    }
    return this.ns.getGrowTime(server);
  }

  estimateStableThreadCount(server: string, targetMoneyRatio: number, tickLength: number): number {
    // This is a VERY rough estimate, but it's good enough for skipping too-small servers
    const hacksPerBatch = this.hacksFromToMoneyRatio(server, 1, targetMoneyRatio);
    const growsPerBatch = this.growthFromToMoneyRatio(server, targetMoneyRatio, 1);
    const weakensPerBatch = this.weakenAfterGrows(growsPerBatch) + this.weakenAfterHacks(hacksPerBatch);
    const concurrentBatches = this.getWeakenTime(server) / tickLength;
    return Math.round((hacksPerBatch + growsPerBatch + weakensPerBatch) * concurrentBatches);
  }
}
