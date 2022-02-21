import { NS } from '@ns'

export async function main(ns: NS): Promise<void> {
    while (true) {
        const time = ns.commitCrime('Shoplift');
        await ns.sleep(time);
        while (ns.isBusy()) {
            await ns.sleep(1000);
        }
    }
}