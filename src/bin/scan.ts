import { AutohackContext } from '/lib/autohack/context';

import { NS } from '@ns';

import { JobType } from 'lib/autohack/executor';
import { discoverHackedHosts } from 'lib/distributed';

export async function main(ns: NS): Promise<void> {
  const ctx = new AutohackContext(ns);
  ctx.loadConfig();
  const hosts = discoverHackedHosts(ns);
  hosts.sort((a, b) => ns.getServerMaxMoney(a) - ns.getServerMaxMoney(b));

  const flags = ns.flags([
    ['host', ''],
    ['tickLength', ctx.tickLength],
    ['targetMoneyRatio', ctx.config.targetMoneyRatio],
  ]);
  // @ts-ignore
  ns.tprint(ctx.fmt.keyValue(...Object.entries(flags).map(([k, v]) => [k, v.toString()])));

  const headers = [
    'Host',
    'Hack Time',
    'Grow Time',
    'Weaken Time',
    'Est. Workers',
    'Max Money',
    `${ctx.fmt.percent(flags.targetMoneyRatio)} Money per worker`,
  ];
  const rows: string[][] = [];

  for (const host of hosts) {
    if (ns.getServer(host).purchasedByPlayer) {
      continue;
    }

    if (flags.host === '' || flags.host === host) {
      rows.push([
        host,
        ctx.fmt.time(ns.getHackTime(host)),
        ctx.fmt.time(ns.getGrowTime(host)),
        ctx.fmt.time(ns.getWeakenTime(host)),
        ctx.formulas.estimateStableThreadCount(host, flags.targetMoneyRatio, flags.tickLength).toString(),
        ctx.fmt.money(ns.getServerMaxMoney(host)),
        ctx.fmt.money(
          (ns.getServerMaxMoney(host) * flags.targetMoneyRatio) /
            ctx.formulas.estimateStableThreadCount(host, flags.targetMoneyRatio, flags.tickLength),
        ),
      ]);
    }
  }

  for (const line of ctx.fmt.table(headers, ...rows)) {
    ns.tprint(line);
  }

  await ctx.executor.update();
  ns.tprint(`Max grow threads: ${ctx.executor.getMaximumThreads(JobType.Grow)}`);
}
