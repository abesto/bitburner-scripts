import { NS } from '@ns';

export async function main(ns: NS): Promise<void> {
  while (true) {
    const time = ns.commitCrime('Shoplift');
    await ns.asleep(time);
    while (ns.isBusy()) {
      await ns.asleep(1000);
    }
  }
}
