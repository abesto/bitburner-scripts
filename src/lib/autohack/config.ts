import { NS } from '@ns';

import { parseMoney } from 'lib/fmt';

export interface Config {
  tickLength: number;
  statsPeriod: number;
  reservedMoney: number;
  targetMoneyRatio: number;
  reservedRam: number;
  debug: string[];
}

const DEFAULT_CONFIG: Config = {
  tickLength: 1000,
  statsPeriod: 30000,
  reservedMoney: 0,
  targetMoneyRatio: 0.75,
  reservedRam: 16,
  debug: [],
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
