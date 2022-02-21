import { NS } from '@ns'

export async function main(ns: NS): Promise<void> {
    const hostname = ns.args[0] as string;
    await ns.scp(ns.ls(ns.getHostname(), '/bin'), hostname);
    await ns.scp(ns.ls(ns.getHostname(), '/lib'), hostname);
}