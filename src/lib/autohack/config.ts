import { NS } from '@ns';

import { Fmt } from 'lib/fmt';

export interface Config {
  baseTickLength: number;
  timeEpsilon: number;
  statsPeriod: number;
  securityThreshold: number;
  reservedMoney: number;
  targetMoneyRatio: number;
  reservedRam: number;
  debug: string[];
  concurrentTargets: number;
  serverPurchaseInterval: number;
  emergencyShutdownMoneyRatio: number;
  retargetUtilThreshold: number;
  retargetInterval: number;
  pickServersUpToUtil: number;
  slowServersDownToUtil: number;
}

export const DEFAULT_CONFIG: Config = {
  baseTickLength: 400, // you probably want this at timeEpsilon * 8
  statsPeriod: 5000,
  securityThreshold: 5,
  timeEpsilon: 50,
  reservedMoney: 0,
  targetMoneyRatio: 0.75,
  reservedRam: 16,
  debug: [],
  concurrentTargets: 5,
  serverPurchaseInterval: 5000,
  emergencyShutdownMoneyRatio: 0.1,
  retargetUtilThreshold: 0.7,
  retargetInterval: 10000,
  pickServersUpToUtil: 1.1,
  slowServersDownToUtil: 0.9,
};

const TimeSuffixes: { [suffix: string]: number } = {
  s: 1000,
  m: 60 * 1000,
};
function parseTime(x: string | number): number {
  if (typeof x === 'string') {
    const [, num, suffix] = x.match(/^([0-9.]+)([a-z]?)$/i) || [];
    return parseFloat(num) * TimeSuffixes[suffix] || 0;
  }
  return x;
}

export function loadConfig(ns: NS, fmt: Fmt): Config | null {
  const s = ns.read('/autohack/config.txt');
  if (!s) {
    ns.print('No config file found');
    return null;
  }
  try {
    const fromFile = JSON.parse(s);
    if ('reservedMoney' in fromFile) {
      fromFile.reservedMoney = fmt.parseMoney(fromFile.reservedMoney);
    }
    return fromFile;
  } catch (e) {
    ns.print(`Error parsing config, ignoring the file: ${e}`);
    return null;
  }
}
