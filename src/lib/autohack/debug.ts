import { NS } from '@ns';

import { CONFIG, loadConfig } from 'lib/autohack/config';
import { _ns, Debug as LibDebug, init as libInit } from 'lib/debug';

export const initDebug = libInit;
export const DEBUG = LibDebug((category: string) => {
  loadConfig(_ns);
  return CONFIG.debug.includes(category);
});
