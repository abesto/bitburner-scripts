import { NS } from '@ns';

import { discoverHackedHosts } from 'lib/distributed';

export async function main(ns: NS): Promise<void> {
  for (const host of discoverHackedHosts(ns)) {
    for (const file of await ns.ls(host)) {
      if (file.endsWith('.cct')) {
        ns.tprint(`${host} ${file}`);
      }
    }
  }
}
