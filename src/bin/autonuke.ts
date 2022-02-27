import { NS } from '@ns';

import { autonuke } from 'lib/autonuke';

export async function main(ns: NS): Promise<void> {
  while (true) {
    let success = false;
    for (const result of autonuke(ns)) {
      const prefix = result.success ? '[+]' : '[-]';
      ns.tprint(`${prefix} ${result.message}`);
      success ||= result.success;
    }
    if (!success) {
      return;
    }
  }
}
