import { NS } from '@ns'

export async function main(ns: NS): Promise<void> {
    const queue: string[][] = [[ns.getHostname()]];
    const seen: string[] = [];

    while (queue.length > 0) {
        const path = queue.shift() as string[];
        const hostname = path[path.length - 1];

        if (seen.includes(hostname)) {
            continue;
        }
        seen.push(hostname);

        if (!ns.hasRootAccess(hostname)) {
            continue;
        }

        if (!ns.getServer(hostname).backdoorInstalled) {
            for (const hop of path) {
                ns.connect(hop);
            }
            ns.connect(hostname);
            ns.tprint(`Installing backdoor on ${hostname}`);
            await ns.installBackdoor();

            path.reverse();
            for (const hop of path) {
                ns.connect(hop);
            }
            ns.connect('home');
            path.reverse();
        }

        for (const next of ns.scan(hostname)) {
            queue.push([...path, next]);
        }
    }
}