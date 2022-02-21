import { NS } from '@ns'

export function discoverHackedHosts(ns: NS): string[] {
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

export async function exec(ns: NS, count: number | null, script: string, ...args: string[]): Promise<void> {
    const memNeeded = ns.getScriptRam(script);
    if (memNeeded === 0) {
        ns.print(`${script} doesn't exist (needs no RAM)`);
        return;
    }
    const sources = discoverHackedHosts(ns);

    let sourceIndex = 0;
    let started = 0;
    while ((count === null || started < count) && sourceIndex < sources.length) {
        //ns.print(`${sources[sourceIndex]} memcheck ${script}: ${ns.getServerMaxRam(sources[sourceIndex])} - ${ns.getServerUsedRam(sources[sourceIndex])} <? ${memNeeded}`)
        if (ns.getServerMaxRam(sources[sourceIndex]) - ns.getServerUsedRam(sources[sourceIndex]) < memNeeded) {
            sourceIndex += 1;
            continue;
        }
        const source = sources[sourceIndex] as string;
        //const cores = ns.getServer(source).cpuCores;
        //args = args.map(arg => arg === '$CORES$' ? cores.toString() : arg);

        const remoteScript = `${script}-${started}.js`;
        //ns.print(`[exec] ${source}: ${script} ${args.join(' ')}`);
        await ns.scp(script, source);
        await ns.mv(source, script, remoteScript);
        if (ns.exec(remoteScript, source, undefined, ...args) === 0) {
            ns.print("Failed to exec");
        }
        started += 1;
    }

    if (count !== null && started < count) {
        ns.print(`Not enough hacked hosts; ${count - started} executions remain unscheduled`);
    }
    ns.print(`${started} executions started of ${script} ${args.join(' ')}`);
}