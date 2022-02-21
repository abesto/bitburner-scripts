import { NS } from '@ns'

function discoverHackedHosts(ns: NS): string[] {
    const hosts: string[] = [];
    const queue: string[] = [ns.getHostname()];
    const seen: string[] = [];

    while (queue.length > 0) {
        const hostname = queue.shift() as string;

        if (seen.includes(hostname)) {
            continue;
        }
        seen.push(hostname);

        if (!ns.hasRootAccess(hostname)) {
            continue;
        }

        hosts.push(hostname);
        queue.push(...ns.scan(hostname));
    }

    return hosts;
}

export async function main(ns: NS): Promise<void> {
    const script = '/bin/autohack.js';
    const memNeeded = ns.getScriptRam(script);
    const hosts = discoverHackedHosts(ns);

    const sources: string[] = Object.assign([], hosts);
    const targets: string[] = Object.assign([], hosts).filter(hostname => hostname !== ns.getHostname());

    for (const source of sources) {
        await ns.scp(script, ns.getHostname(), source);
    }

    const action = ns.args[0] as string;

    if (action === 'start') {
        let targetIndex = targets.length;
        let sourceIndex = 0;
        while (sourceIndex < sources.length) {
            ns.print(`${ns.getServerMaxRam(sources[sourceIndex])} - ${ns.getServerUsedRam(sources[sourceIndex])} <? ${memNeeded})`)
            if (ns.getServerMaxRam(sources[sourceIndex]) - ns.getServerUsedRam(sources[sourceIndex]) < memNeeded) {
                sourceIndex += 1;
                continue;
            }
            const source = sources[sourceIndex] as string;

            if (targetIndex >= targets.length - 1) {
                targetIndex = 0;
            } else {
                targetIndex += 1;
            }
            const target = targets[targetIndex] as string;
            const threads = ns.getServer(target).cpuCores;

            ns.tprintf(`${source} -> ${target} (threads: ${threads})`);
            if (ns.exec(script, source, 1, target, threads) === 0) {
                ns.tprintf("Failed to exec");
                return;
            }
        }
    } else if (action === 'stop') {
        for (const source of sources) {
            ns.scriptKill(script, source);
            ns.tprintf(`${source} stopped`);
        }
    } else {
        ns.tprintf(`Unknown action: ${action}`);
    }
}