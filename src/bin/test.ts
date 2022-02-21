import { NS } from '@ns'

export async function main(ns: NS): Promise<void> {
    const server = ns.getPurchasedServers().filter(h => h.startsWith("worker-")).reduce((a, b) => {
        if (ns.getServerMaxRam(a) > ns.getServerMaxRam(b)) {
            return b;
        }
        return a;
    });
    ns.tprint(`Deleting weakest server: ${server} (${ns.getServerMaxRam(server)}GB)`);
    //ns.deleteServer(server);
}