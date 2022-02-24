import { discoverHackedHosts } from '/lib/distributed';

import { NS } from '@ns';

import * as fmt from 'lib/fmt';

function getFullGrowTime(ns: NS, hostname: string, workers: number): number {
  const wantedMultiplier = ns.getServerMaxMoney(hostname) / ns.getServerMoneyAvailable(hostname);
  if (!wantedMultiplier) {
    return 0;
  }
  const wantGrow = Math.ceil(ns.growthAnalyze(hostname, wantedMultiplier));
  const time = ns.getGrowTime(hostname) * wantGrow;
  return time / workers;
}

function getMaxHackMoneyPerSec(ns: NS, host: string): number {
  return (ns.hackAnalyze(host) * ns.getServerMaxMoney(host)) / ns.getHackTime(host);
}

export async function main(ns: NS): Promise<void> {
  const hosts = discoverHackedHosts(ns);
  const workers = discoverHackedHosts(ns)
    .flatMap(host =>
      ns
        .ps(host)
        .filter(p => p.filename.startsWith('/bin/autohack/executor_scripts/'))
        .map(p => p.threads),
    )
    .reduce((a, b) => a + b, 0);
  hosts.sort((a, b) => getMaxHackMoneyPerSec(ns, a) - getMaxHackMoneyPerSec(ns, b));

  const headers = ['Host', 'Full Grow Time', 'Hack Time', 'Grow Time', 'Max Hack Money Per Sec', 'Available Money'];
  const rows: string[][] = [];

  for (const host of hosts) {
    if (ns.getServer(host).purchasedByPlayer) {
      continue;
    }
    if (getFullGrowTime(ns, host, workers) >= 120 * 1000) {
      continue;
    }

    rows.push([
      host,
      fmt.time(ns, getFullGrowTime(ns, host, workers)),
      fmt.time(ns, ns.getHackTime(host)),
      fmt.time(ns, ns.getGrowTime(host)),
      fmt.money(ns, getMaxHackMoneyPerSec(ns, host)),
      fmt.money(ns, ns.getServerMaxMoney(host)),
    ]);
  }

  for (const line of fmt.table(ns, headers, ...rows)) {
    ns.tprint(line);
  }
}
