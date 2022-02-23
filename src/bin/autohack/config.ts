import { NS } from '@ns';

export interface Config {
  tickLength: number;
  statsPeriod: number;
  purchaseRam: number;
  reservedMoney: number;
  targetMoneyRatio: number;
  reservedRam: number;
  target: string;
  workerScript: string;
}

const DEFAULT_CONFIG: Config = {
  tickLength: 1000,
  statsPeriod: 30000,
  purchaseRam: 64,
  reservedMoney: 0,
  targetMoneyRatio: 0.75,
  reservedRam: 16,
  target: 'n00dles',
  workerScript: '/bin/autohack/worker.js',
};

export const CONFIG = DEFAULT_CONFIG;

export function loadConfig(ns: NS) {
  const config = JSON.parse(ns.read('/autohack/config.txt') || '{}') as Config;
  Object.assign(CONFIG, config);
}
