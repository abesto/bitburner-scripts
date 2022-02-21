import { NS } from '@ns'

export async function main(ns: NS): Promise<void> {
    ns.purchaseServer(ns.args[0] as string, parseInt(ns.args[1] as string));
}