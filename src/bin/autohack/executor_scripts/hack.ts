import { NS } from '@ns';

export async function main(ns: NS): Promise<void> {
  const start = Date.now();
  const impact = await ns.hack(ns.args[0] as string);
  const duration = Date.now() - start;
  await ns.write(
    `/autohack/results/${ns.args[1]}-${ns.args[2]}.txt`,
    JSON.stringify({
      impact,
      duration,
    }),
  );
}
