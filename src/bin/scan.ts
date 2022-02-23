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
  hosts.sort((a, b) => getFullGrowTime(ns, a, workers) - getFullGrowTime(ns, b, workers));
  for (const host of hosts) {
    if (ns.getServer(host).purchasedByPlayer) {
      continue;
    }
    const fullGrowTime = getFullGrowTime(ns, host, workers);
    const maxMoney = ns.getServerMaxMoney(host);
    const hackTime = ns.getHackTime(host);
    const growTime = ns.getGrowTime(host);
    const maxHackMoneyPerSec = (ns.hackAnalyze(host) * ns.getServerMaxMoney(host)) / ns.getHackTime(host);
    ns.tprint(
      `${host}; fullGrowTime=${fmt.time(ns, fullGrowTime)}; maxMoney=${fmt.money(ns, maxMoney)}; hackTime=${fmt.time(
        ns,
        hackTime,
      )}; maxHackMoneyPerSec=${fmt.money(ns, maxHackMoneyPerSec)}; growTime=${fmt.time(
        ns,
        growTime,
      )}; availableMoney=${fmt.money(ns, ns.getServerMoneyAvailable(host))}`,
    );
  }
}
