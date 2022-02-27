import { NS } from '@ns';

let ns: NS;

export function init(_ns: NS): void {
  ns = _ns;
}

export function moneyRatio(server: string): number {
  return ns.getServerMoneyAvailable(server) / ns.getServerMaxMoney(server);
}

let lastFormulasCheck = 0;
let _haveFormulas = false;
function haveFormulas(): boolean {
  if (Date.now() - lastFormulasCheck > 1000) {
    lastFormulasCheck = Date.now();
    _haveFormulas = ns.fileExists('Formulas.exe');
  }
  return _haveFormulas;
}

export function growthForMoneyMultiplier(server: string, targetMultiplier: number): number {
  let threads = Math.ceil(ns.growthAnalyze(server, targetMultiplier));
  if (haveFormulas()) {
    while (ns.formulas.hacking.growPercent(ns.getServer(server), threads, ns.getPlayer()) < targetMultiplier) {
      threads++;
    }
  }
  return threads;
}

export function growthToTargetMoneyRatio(server: string, targetMoneyRatio: number): number {
  const currentMoneyRatio = moneyRatio(server);
  const targetMultiplier = targetMoneyRatio / currentMoneyRatio;
  return growthForMoneyMultiplier(server, targetMultiplier);
}

export function growthFromToMoneyRatio(server: string, from: number, to: number): number {
  return growthForMoneyMultiplier(server, to / from);
}

export function almostEquals(a: number, b: number, epsilon: number): boolean {
  return Math.abs(a - b) < epsilon;
}

export function getBaseLog(base: number, x: number): number {
  return Math.log(x) / Math.log(base);
}

export function hacksFromToMoneyRatio(server: string, from: number, to: number): number {
  const targetPercent = from - to;
  if (haveFormulas()) {
    const hackPercent = ns.formulas.hacking.hackPercent(ns.getServer(server), ns.getPlayer());
    return Math.ceil(targetPercent / hackPercent);
    //return Math.ceil(getBaseLog(1 - hackPercent, targetPercent));
  }
  const targetMoneyStolen = ns.getServerMaxMoney(server) * targetPercent;
  const threads = Math.ceil(ns.hackAnalyzeThreads(server, targetMoneyStolen));
  return threads;
}

export function weakenForSecurityDecrease(security: number): number {
  // This makes the bold assumption that weakens are linear
  return Math.ceil(security / ns.weakenAnalyze(1));
}

export function weakenToMinimum(server: string): number {
  return weakenForSecurityDecrease(ns.getServerSecurityLevel(server) - ns.getServerMinSecurityLevel(server));
}

export function weakenAfterHacks(hacks: number): number {
  const security = ns.hackAnalyzeSecurity(hacks);
  return weakenForSecurityDecrease(security);
}

export function weakenAfterGrows(grows: number): number {
  const security = ns.growthAnalyzeSecurity(grows);
  return weakenForSecurityDecrease(security);
}

export function getWeakenTime(server: string): number {
  if (haveFormulas()) {
    return ns.formulas.hacking.weakenTime(ns.getServer(server), ns.getPlayer());
  }
  return ns.getWeakenTime(server);
}

export function getHackTime(server: string): number {
  if (haveFormulas()) {
    return ns.formulas.hacking.growTime(ns.getServer(server), ns.getPlayer());
  }
  return ns.getHackTime(server);
}

export function getGrowTime(server: string): number {
  if (haveFormulas()) {
    return ns.formulas.hacking.growTime(ns.getServer(server), ns.getPlayer());
  }
  return ns.getGrowTime(server);
}
