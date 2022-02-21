import { NS } from '@ns'
import { discoverHackedHosts } from 'lib/distributed'

export async function main(ns: NS): Promise<void> {
    for (const host of discoverHackedHosts(ns)) {
        for (const path of ns.ls(host, "/autohack/workers")) {
            await ns.rm(path, host);
        }
    }
}