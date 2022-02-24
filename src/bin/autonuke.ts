import { NS } from '@ns';

import { autonuke } from 'lib/autonuke';

export async function main(ns: NS): Promise<void> {
  for (const result of autonuke(ns)) {
    const prefix = result.success ? '[+]' : '[-]';
    ns.tprint(`${prefix} ${result.message}`);
  }
}
