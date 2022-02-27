import { NS } from '@ns';

export async function main(ns: NS): Promise<void> {
  const queue: string[][] = [[ns.getHostname()]];
  const seen: string[] = [];

  while (queue.length > 0) {
    const path = queue.shift() as string[];
    const hostname = path[path.length - 1];

    if (seen.includes(hostname)) {
      continue;
    }
    seen.push(hostname);

    if (!ns.hasRootAccess(hostname)) {
      continue;
    }

    if (
      (ns.args[0] === undefined || ns.args[0] === hostname) &&
      !ns.getServer(hostname).backdoorInstalled &&
      !ns.getServer(hostname).purchasedByPlayer
    ) {
      ns.tprint(
        `home; ${path
          .filter(h => h != 'home')
          .map(h => `connect ${h}`)
          .join('; ')}; backdoor`,
      );
    }

    for (const next of ns.scan(hostname)) {
      queue.push([...path, next]);
    }
  }
}
