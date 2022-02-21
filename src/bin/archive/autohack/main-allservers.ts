/*
//commented out for compile errors
import { NS } from '@ns'
import { discoverHackedHosts } from 'lib/distributed';
import { writeMessage, readMessage, MessageType, Message } from 'bin/autohack/messages';
import { Port } from 'lib/constants';

async function deployWorkers(ns: NS, hostname: string): Promise<number> {
    const script = '/bin/autohack/worker.js';
    const freeMem = ns.getServerMaxRam(hostname) - ns.getServerUsedRam(hostname);
    const reservedMem = hostname === ns.getHostname() ? parseInt(ns.read('/autohack/reserved-ram.txt') || '0') : 0;
    const workerCount = Math.floor((freeMem - reservedMem) / ns.getScriptRam(script));
    if (workerCount < 1) {
        return 0;
    }

    await ns.scp(ns.ls(ns.getHostname(), '/bin'), hostname);
    await ns.scp(ns.ls(ns.getHostname(), '/lib'), hostname);

    for (let i = 0; i < workerCount; i++) {
        const remoteScript = `/autohack/workers/${i}.js`;
        if (hostname === ns.getHostname()) {
            await ns.scp(script, 'n00dles');
            await ns.mv(hostname, script, remoteScript);
            await ns.scp(script, 'n00dles', hostname);
        } else {
            await ns.scp(script, hostname);
            await ns.mv(hostname, script, remoteScript);
        }
        await ns.exec(remoteScript, hostname, 1, i);
    }

    ns.print(`Deployed ${workerCount} workers on ${hostname}`);
    return workerCount;
}

async function deployAllWorkers(ns: NS): Promise<number> {
    const hosts = discoverHackedHosts(ns);
    let sum = 0;
    for (const hostname of hosts) {
        sum += await deployWorkers(ns, hostname);
    }
    ns.print(`Deployed ${sum} workers`);
    return sum;
}

async function ping(ns: NS): Promise<string | null> {
    await writeMessage(ns, Port.AutohackCommand, { type: MessageType.Ping, payload: '' });
    const start = new Date().getTime();
    while (new Date().getTime() < start + 1000) {
        const message = await readMessage(ns, Port.AutohackResponse);
        if (message === null) {
            await ns.sleep(100);
            continue;
        }
        return message.payload;
    }
    return null;
}

async function shutdownWorkers(ns: NS): Promise<void> {
    let count = 0;
    while (await ping(ns) !== null) {
        for (let i = 0; i < 10; i++) {
            await writeMessage(ns, Port.AutohackCommand, { type: MessageType.Shutdown, payload: '' });
            count += 1;
        }
    }
    ns.clearPort(Port.AutohackCommand);
    ns.print("Shutdown ~%d workers", count);
}

async function killWorkers(ns: NS): Promise<void> {
    const hosts = discoverHackedHosts(ns);
    let killed = 0;
    for (const host of hosts) {
        for (const process of ns.ps(host)) {
            if (process.filename.startsWith("/autohack/workers/")) {
                await ns.kill(process.filename, host, ...process.args);
                killed += 1;
            }
        }
    }
    ns.print(`Killed ${killed} workers`);
}

class JobRegistry {
    ends: { [hostname: string]: number[] } = {};
    limit: number;

    constructor(limit: number) {
        this.limit = limit;
    }

    prune() {
        for (const hostname of Object.keys(this.ends)) {
            const ends = this.ends[hostname];
            const now = new Date().getTime();
            while (ends.length > 0 && ends[0] < now) {
                ends.shift();
            }
        }
    }

    async want(ns: NS, workerPool: Pool, count: number, length: number, message: Message): Promise<number> {
        this.prune();
        const ends = this.ends[message.payload] || [];
        const now = new Date().getTime();
        const remaining = count - ends.length;
        const want = Math.min(remaining, workerPool.workers * this.limit);
        if (remaining > 0) {
            const got = await workerPool.submit(ns, want, length, message);
            for (let i = 0; i < got; i++) {
                ends.push(now + length);
            }
            this.ends[message.payload] = ends;
            return got;
        }
        return 0;
    }
}

class Pool {
    workers: number
    ends: number[] = []

    constructor(workers: number) {
        this.workers = workers;
    }

    prune() {
        const now = new Date().getTime();
        while (this.ends.length > 0 && this.ends[0] < now) {
            this.ends.shift();
        }
    }

    async submit(ns: NS, count: number | null, length: number, message: Message): Promise<number> {
        this.prune();
        const available = this.workers - this.ends.length;
        const booked = Math.min(available, count || available);
        const end = new Date().getTime() + length;
        for (let i = 0; i < booked; i++) {
            this.ends.push(end);
            let popped = await writeMessage(ns, Port.AutohackCommand, message);
            while (popped) {
                await ns.sleep(100);
                popped = await writeMessage(ns, Port.AutohackCommand, popped);
            }
        }
        return booked;
    }
}

function purchaseWorkers(ns: NS): string[] {
    const ram = parseInt(ns.read('/autohack/purchase-ram.txt' || '64'));
    const cost = ns.getPurchasedServerCost(ram);
    let index = 0;
    const workers = [];

    const reservedMoney = parseInt(ns.read('/autohack/reserved-money.txt') || '0');
    while (ns.getPlayer().money - cost > reservedMoney) {
        while (ns.serverExists(`worker-${index}`)) {
            index += 1;
        }
        ns.purchaseServer(`worker-${index}`, ram);
        workers.push(`worker-${index}`);
        ns.print(`Purchased worker-${index} with ${ram}GB RAM`);
    }

    return workers;
}

export async function main(ns: NS): Promise<void> {
    ns.disableLog("ALL");

    ns.clearPort(Port.AutohackCommand);
    ns.clearPort(Port.AutohackResponse);

    const action = ns.args[0];
    if (action === 'deploy-workers') {
        await deployAllWorkers(ns);
    } else if (action === 'ping') {
        const worker = await ping(ns);
        ns.tprint(worker);
    } else if (action === 'shutdown-workers') {
        await shutdownWorkers(ns);
    } else if (action === 'kill-workers') {
        await killWorkers(ns);
    } else if (action === 'hack') {
        await killWorkers(ns);
        const workerCount = await deployAllWorkers(ns);

        const growRegistry = new JobRegistry(0.25);
        const weakenRegistry = new JobRegistry(0.25);
        const workerPool = new Pool(workerCount);

        const targetMoneyRatios: { [hostname: string]: number } = {};

        while (true) {
            await ns.sleep(1000);
            ///for (const newServer of purchaseWorkers(ns)) {
            ///const newWorkerCount = await deployWorkers(ns, newServer);
            ///workerPool.workers += newWorkerCount;
            ///}

            const hosts = discoverHackedHosts(ns).filter(h => !ns.getServer(h).purchasedByPlayer);
            const hackCandidates: { [host: string]: number } = {};

            for (const hostname of hosts) {
                if (!(hostname in targetMoneyRatios)) {
                    targetMoneyRatios[hostname] = ns.getServerMoneyAvailable(hostname) / ns.getServerMaxMoney(hostname);
                }

                if (ns.hackAnalyzeChance(hostname) < 0.9 && ns.getServerMinSecurityLevel(hostname) + 0.1 < ns.getServerSecurityLevel(hostname)) {
                    const weakenImpact = ns.weakenAnalyze(1, 1);
                    const wantedCount = Math.ceil(((ns.getServerSecurityLevel(hostname) - ns.getServerMinSecurityLevel(hostname) - 1) / weakenImpact) * (ns.getWeakenTime(hostname) / ns.getHackTime(hostname)));
                    const weakenTime = ns.getWeakenTime(hostname);
                    if (weakenTime < 120 * 60 * 5) {
                        const newJobCount = await weakenRegistry.want(ns, workerPool, wantedCount, weakenTime, { type: MessageType.Weaken, payload: hostname });
                        if (newJobCount > 0) {
                            ns.print(`[scheduled] ${newJobCount}/${wantedCount} new weaken jobs for ${hostname} (time: ${Math.round(weakenTime) / 1000}s)`);
                        }
                    }
                }

                const TARGET_MONIES = targetMoneyRatios[hostname];
                if (ns.getServerMoneyAvailable(hostname) < ns.getServerMaxMoney(hostname) * TARGET_MONIES) {
                    // available * x = max * TARGET
                    // x = max * TARGET / available
                    const wantedMultiplier = ns.getServerMaxMoney(hostname) * TARGET_MONIES / ns.getServerMoneyAvailable(hostname);
                    const wantedCount = Math.ceil((ns.growthAnalyze(hostname, wantedMultiplier)) * (ns.getGrowTime(hostname) / ns.getHackTime(hostname)));
                    const growTime = ns.getGrowTime(hostname);
                    if (growTime < 1000 * 60 * 5) {
                        const newJobCount = await growRegistry.want(ns, workerPool, wantedCount, growTime, { type: MessageType.Grow, payload: hostname });
                        if (newJobCount > 0) {
                            ns.print(`[scheduled] ${newJobCount}/${wantedCount} new growth jobs for ${hostname} (time: ${Math.round(growTime / 1000)}s)`);
                        }
                    }
                }

                const moneyAvailable = ns.getServerMoneyAvailable(hostname);
                const hackRatio = ns.hackAnalyze(hostname);
                const hackChance = ns.hackAnalyzeChance(hostname);
                const hackTime = ns.getHackTime(hostname);

                const hackIncome = moneyAvailable * hackRatio;
                const hackValue = hackIncome * hackChance / hackTime;

                hackCandidates[hostname] = hackValue;
            }

            const bestHackTarget = Object.keys(hackCandidates).sort((a, b) => hackCandidates[b] - hackCandidates[a])[0];
            if (!bestHackTarget) {
                ns.print("No hack candidates");
                continue;
            }
            const hackTime = ns.getHackTime(bestHackTarget);
            const hackValue = hackCandidates[bestHackTarget];
            const hackIncome = hackValue * hackTime;
            if (hackIncome < 3000) {
                if (Object.values(growRegistry.ends).reduce((a, b) => a + b.length, 0) < workerPool.workers * 0.75) {
                    ns.print(`Best hack candidate ${bestHackTarget} is too cheap (${hackIncome}), bumping growth`);
                    growRegistry.limit = 1;
                    const newJobCount = await growRegistry.want(ns, workerPool, workerPool.workers, ns.getGrowTime(bestHackTarget), { type: MessageType.Grow, payload: bestHackTarget });
                    ns.print(`[scheduled] ${newJobCount} new growth jobs for ${bestHackTarget} (time: ${Math.round(ns.getGrowTime(bestHackTarget) / 1000)}s)`);
                    if (newJobCount > workerPool.workers * 0.5) {
                        targetMoneyRatios[bestHackTarget] *= 2;
                    }
                }
                continue;
            } else {
                growRegistry.limit = 0.25;
            }

            const hacksScheduled = await workerPool.submit(ns, Math.ceil(workerPool.workers / (hackTime / 1000)), hackTime, { type: MessageType.Hack, payload: bestHackTarget });
            if (hacksScheduled > 0) {
                ns.print(`[scheduled] ${hacksScheduled} hack jobs against ${bestHackTarget}. Hack time ${Math.round(hackTime / 1000)} seconds`);
            }

            let sum = 0;
            let count = 0;
            const timeout = new Date().getTime() + 1500;
            while (new Date().getTime() < timeout) {
                const message = await readMessage(ns, Port.AutohackResponse);
                if (message === null) {
                    await ns.sleep(100);
                    continue;
                }
                if (message.type === MessageType.HackedAmount) {
                    sum += parseFloat(message.payload || '0');
                    count += 1;
                } else {
                    ns.print(`Unexpected message: ${JSON.stringify(message)} `);
                }
            }
            if (sum > 0) {
                ns.print(`[income] Hacked amount: ${sum} in ${count} hacks (avg: ${Math.round(sum / count)})`);
            }
        }
    }
}
*/