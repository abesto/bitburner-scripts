import { discoverHackedHosts } from '/lib/distributed';

import { NS } from '@ns';

import * as fmt from 'lib/fmt';
import * as fm from 'lib/formulas';

export async function main(ns: NS): Promise<void> {
  fmt.init(ns);
  fm.init(ns);
  const hosts = discoverHackedHosts(ns);
  hosts.sort((a, b) => ns.getServerMaxMoney(a) - ns.getServerMaxMoney(b));

  const headers = ['Host', 'Hack Time', 'Grow Time', 'Weaken Time', 'Est. Workers', '25% Money', 'Max Money'];
  const rows: string[][] = [];

  for (const host of hosts) {
    if (ns.getServer(host).purchasedByPlayer) {
      continue;
    }

    if (ns.getServer(host).moneyMax === 0 || ns.getServer(host).moneyAvailable === 0) {
      continue;
    }

    rows.push([
      host,
      fmt.time(ns.getHackTime(host)),
      fmt.time(ns.getGrowTime(host)),
      fmt.time(ns.getWeakenTime(host)),
      (
        (fm.growthFromToMoneyRatio(host, 0.5, 1) * fm.getGrowTime(host)) / 1000 +
        (fm.weakenForSecurityDecrease(10) * fm.getWeakenTime(host)) / 1000 +
        (fm.hacksFromToMoneyRatio(host, 1, 0.5) * fm.getHackTime(host)) / 1000
      ).toString(),
      fmt.money(ns.getServerMaxMoney(host) * 0.25),
      fmt.money(ns.getServerMaxMoney(host)),
    ]);
  }

  for (const line of fmt.table(headers, ...rows)) {
    ns.tprint(line);
  }
}
