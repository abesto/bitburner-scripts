import { NS } from '@ns';

import { discoverHackedHosts } from 'lib/distributed';

export async function main(ns: NS): Promise<void> {
  for (const host of discoverHackedHosts(ns)) {
    for (const file of await ns.ls(host)) {
      if (file.endsWith('.cct')) {
        ns.tprint(`Coding contract: ${host} ${file}`);
      } else if (!ns.fileExists(file)) {
        await ns.scp(file, host, ns.getHostname());
        ns.tprint(`${host}:${file}`);
      }
    }
  }
}
