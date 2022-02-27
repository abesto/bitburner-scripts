import { NS } from '@ns';

function discoverHackableHosts(ns: NS): string[] {
  const hosts: string[] = [];
  const queue: string[] = [ns.getHostname()];
  const seen: string[] = [];

  while (queue.length > 0) {
    const hostname = queue.shift() as string;

    if (seen.includes(hostname)) {
      continue;
    }
    seen.push(hostname);

    if (!ns.hasRootAccess(hostname)) {
      hosts.push(hostname);
      continue;
    }

    if (ns.hasRootAccess(hostname)) {
      queue.push(...ns.scan(hostname));
    }
  }

  return hosts;
}

interface Result {
  success: boolean;
  message: string;
}

export function autonuke(ns: NS): Result[] {
  const hosts = discoverHackableHosts(ns);
  const hackingLevel = ns.getHackingLevel();
  const results: Result[] = [];

  for (const host of hosts) {
    const hostHackingLevel = ns.getServerRequiredHackingLevel(host);

    if (hackingLevel < hostHackingLevel) {
      results.push({
        success: false,
        message: `${host}: Hacking level too low (${hackingLevel} < ${hostHackingLevel})`,
      });
      continue;
    }

    if (ns.fileExists('BruteSSH.exe')) {
      ns.brutessh(host);
    }
    if (ns.fileExists('FTPCrack.exe')) {
      ns.ftpcrack(host);
    }
    if (ns.fileExists('HTTPWorm.exe')) {
      ns.httpworm(host);
    }
    if (ns.fileExists('SQLInject.exe')) {
      ns.sqlinject(host);
    }
    if (ns.fileExists('relaySMTP.exe')) {
      ns.relaysmtp(host);
    }

    const requiredPorts = ns.getServerNumPortsRequired(host);
    const ports = ns.getServer(host).openPortCount;
    if (ports < requiredPorts) {
      results.push({
        success: false,
        message: `${host}: Not enough ports open (${ports} < ${requiredPorts})`,
      });
      continue;
    }

    ns.nuke(host);
    results.push({
      success: true,
      message: `${host}: Nuked!`,
    });
  }

  return results;
}
