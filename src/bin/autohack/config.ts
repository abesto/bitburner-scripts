import { NS } from '@ns';

export interface Config {
  tickLength: number;
  statsPeriod: number;
  reservedMoney: number;
  targetMoneyRatio: number;
  reservedRam: number;
  target: string;
  workerScript: string;
}

const DEFAULT_CONFIG: Config = {
  tickLength: 1000,
  statsPeriod: 30000,
  reservedMoney: 0,
  targetMoneyRatio: 0.75,
  reservedRam: 16,
  target: 'n00dles',
  workerScript: '/bin/autohack/worker.js',
};

export const CONFIG = DEFAULT_CONFIG;

const MoneySuffixes: { [suffix: string]: number } = {
  k: 3,
  m: 6,
  b: 9,
};
function parseMoney(x: string | number): number {
  if (typeof x === 'string') {
    const [, num, suffix] = x.match(/^\$?([0-9.]+)([a-z]?)$/i) || [];
    return parseFloat(num) * 10 ** (MoneySuffixes[suffix] || 0);
  }
  return x;
}

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

export function loadConfig(ns: NS): void {
  const config = JSON.parse(ns.read('/autohack/config.txt') || '{}') as Config;
  if ('reservedMoney' in config) {
    config.reservedMoney = parseMoney(config.reservedMoney);
  }
  Object.assign(CONFIG, config);
}
