import { AutohackContext } from 'lib/autohack/context';
import { Debug as LibDebug } from 'lib/debug';

export type Debug = LibDebug;
export const Debug = (ctx: AutohackContext): LibDebug =>
  LibDebug(ctx.ns, (category: string) => {
    return ctx.config.debug.includes(category);
  });
