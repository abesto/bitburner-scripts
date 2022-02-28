import { NS } from '@ns';

import { parseMoney } from 'lib/fmt';

export interface Config {
  tickLength: number;
  timeEpsilon: number;
  statsPeriod: number;
  securityThreshold: number;
  reservedMoney: number;
  targetMoneyRatio: number;
  reservedRam: number;
  debug: string[];
  concurrentTargets: number;
  tinyWeakenTime: number;
  tinyCapacityThreshold: number;
  serverPurchaseInterval: number;
  serverPurchaseUtilThreshold: number;
}

const DEFAULT_CONFIG: Config = {
  tickLength: 400, // you probably want this at timeEpsilon * 8
  statsPeriod: 5000,
  securityThreshold: 5,
  timeEpsilon: 50,
  reservedMoney: 0,
  targetMoneyRatio: 0.75,
  reservedRam: 16,
  debug: [],
  concurrentTargets: 5,
  tinyWeakenTime: 30000,
  tinyCapacityThreshold: 0.1,
  serverPurchaseInterval: 5000,
  serverPurchaseUtilThreshold: 0.7,
};

export const CONFIG = DEFAULT_CONFIG;

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

let lastLoad = 0;
const maxAge = 1000;

export function loadConfig(ns: NS): void {
  if (Date.now() - lastLoad < maxAge) {
    return;
  }
  const config = JSON.parse(ns.read('/autohack/config.txt') || '{}') as Config;
  if ('reservedMoney' in config) {
    config.reservedMoney = parseMoney(config.reservedMoney);
  }
  Object.assign(CONFIG, config);
  lastLoad = Date.now();
}
