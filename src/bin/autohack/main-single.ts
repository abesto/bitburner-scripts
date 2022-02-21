import { NS } from '@ns'
import { discoverHackedHosts } from 'lib/distributed';
import { writeMessage, readMessage, MessageType, Message, inflatePayload, HackFinishedPayload, WeakenFinishedPayload, GrowFinishedPayload } from 'bin/autohack/messages';
import { Port, Formats } from 'lib/constants';

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
        await ns.exec(script, hostname, 1, `${i}`);
        await ns.sleep(0);
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

async function killWorkersOnHost(ns: NS, host: string): Promise<number> {
    let killed = 0;
    for (const process of ns.ps(host)) {
        if (process.filename == "/bin/autohack/worker.js") {
            await ns.kill(process.filename, host, ...process.args);
            killed += 1;
        }
    }
    return killed;
}

async function killWorkers(ns: NS): Promise<void> {
    const hosts = discoverHackedHosts(ns);
    let killed = 0;
    for (const host of hosts) {
        killed += await killWorkersOnHost(ns, host);
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

async function deleteWeakestWorker(ns: NS, keep: number): Promise<boolean> {
    const server = ns.getPurchasedServers().filter(h => h.startsWith("worker-")).reduce((a, b) => {
        if (ns.getServerMaxRam(a) > ns.getServerMaxRam(b)) {
            return b;
        }
        return a;
    });
    if (ns.getServerMaxRam(server) >= keep) {
        ns.print(`Not deleting weakest worker, it's too big: ${server} (${ns.getServerMaxRam(server)}GB > ${keep}GB)`);
        return false;
    }
    ns.print(`Deleting weakest server: ${server} (${ns.getServerMaxRam(server)}GB)`);
    await killWorkersOnHost(ns, server);
    if (!ns.deleteServer(server)) {
        throw new Error(`Failed to delete server ${server}`);
    }
    return true;
}

async function purchaseWorkers(ns: NS): Promise<string[]> {
    const ram = parseInt(ns.read('/autohack/purchase-ram.txt' || '64'));
    const cost = ns.getPurchasedServerCost(ram);
    const workers = [];

    const reservedMoney = parseInt(ns.read('/autohack/reserved-money.txt') || '0');
    while (ns.getPlayer().money - cost > reservedMoney) {
        if (ns.getPurchasedServerLimit() <= ns.getPurchasedServers().length) {
            if (!await deleteWeakestWorker(ns, ram)) {
                break;
            }
        }
        let index = 0;
        while (ns.serverExists(`worker-${index}`)) {
            index += 1;
        }
        ns.purchaseServer(`worker-${index}`, ram);
        workers.push(`worker-${index}`);
        ns.print(`Purchased worker-${index} with ${ram}GB RAM`);
    }

    return workers;
}

class Stats {
    hacksInProgress = 0;
    hacksSucceeded = 0;
    hacksFailed = 0;
    hackedMoney = 0;

    growsInProgress = 0;
    growsFinished = 0;
    growAmount = 0.0;

    weakensInProgress = 0;
    weakensFinished = 0;
    weakenAmount = 0.0;

    seconds = 0;
    printEvery = 10;

    target: string
    targetMoneyRatio: number;
    targetSecurityLevel: number;

    moneyRatios: number[] = [];
    securityLevels: number[] = [];

    constructor(target: string, targetMoneyRatio: number, targetSecurityLevel: number) {
        this.target = target;
        this.targetMoneyRatio = targetMoneyRatio;
        this.targetSecurityLevel = targetSecurityLevel;
    }

    async tick(ns: NS): Promise<void> {
        await this.processPort(ns);
        this.recordServerState(ns);
        this.seconds += 1;
        if (this.seconds % this.printEvery === 0) {
            this.print(ns);
            this.reset()
        }
    }

    recordServerState(ns: NS) {
        const server = this.target;
        this.moneyRatios.push(ns.getServerMoneyAvailable(server) / ns.getServerMaxMoney(server));
        this.securityLevels.push(ns.getServerSecurityLevel(server));
    }

    recordHack(n: number) {
        this.hacksInProgress += n;
    }

    recordGrow(n: number) {
        this.growsInProgress += n;
    }

    recordWeaken(n: number) {
        this.weakensInProgress += n;
    }

    reset() {
        this.hacksSucceeded = 0;
        this.hacksFailed = 0;
        this.hackedMoney = 0;
        this.growsFinished = 0;
        this.growAmount = 0.0;
        this.weakensFinished = 0;
        this.weakenAmount = 0.0;
        this.seconds = 0;
        this.moneyRatios = [];
        this.securityLevels = [];
    }

    async processPort(ns: NS): Promise<void> {
        while (true) {
            const message = await readMessage(ns, Port.AutohackResponse);
            if (message === null) {
                return;
            }

            if (message.type === MessageType.HackFinished) {
                const payload: HackFinishedPayload = inflatePayload(message);
                if (payload.success) {
                    this.hacksSucceeded += 1;
                    this.hackedMoney += payload.amount;
                } else {
                    this.hacksFailed += 1;
                }
                this.hacksInProgress -= 1;
            }

            if (message.type === MessageType.GrowFinished) {
                this.growsFinished += 1;
                this.growAmount += inflatePayload<GrowFinishedPayload>(message).amount;
                this.growsInProgress -= 1;
            }

            if (message.type == MessageType.WeakenFinished) {
                this.weakensFinished += 1;
                this.weakenAmount += inflatePayload<WeakenFinishedPayload>(message).amount;
                this.growsInProgress -= 1;
            }
        }
    }

    print(ns: NS): void {
        ns.print(`== Stats after ${ns.tFormat(this.printEvery * 1000)} ==`);
        ns.print(`[money-ratio] min=${ns.nFormat(Math.min(...this.moneyRatios), Formats.float)} max=${ns.nFormat(Math.max(...this.moneyRatios), Formats.float)} avg=${ns.nFormat(this.moneyRatios.reduce((a, b) => a + b, 0) / this.moneyRatios.length, Formats.float)} target=${ns.nFormat(this.targetMoneyRatio, Formats.float)}`);
        ns.print(`[security] min=${ns.nFormat(Math.min(...this.securityLevels), Formats.float)} max=${ns.nFormat(Math.max(...this.securityLevels), Formats.float)} avg=${ns.nFormat(this.securityLevels.reduce((a, b) => a + b, 0) / this.securityLevels.length, Formats.float)} target=${ns.nFormat(this.targetSecurityLevel, Formats.float)}`);
        ns.print(`[in-progress] hacks=${this.hacksInProgress} grows=${this.growsInProgress} weakens=${this.weakensInProgress}`);
        if (this.hacksSucceeded > 0 || this.hacksFailed > 0) {
            ns.print(`[hacks] succeeded=${this.hacksSucceeded} failed=${this.hacksFailed} money=${ns.nFormat(this.hackedMoney, Formats.money)} per-sec=${ns.nFormat(this.hackedMoney / this.printEvery, Formats.money)} avg(success)=${ns.nFormat(this.hackedMoney / this.hacksSucceeded, Formats.money)} avg(total)=${ns.nFormat(this.hackedMoney / (this.hacksSucceeded + this.hacksFailed), Formats.money)}`);
        }
        if (this.growsFinished > 0) {
            ns.print(`[grows] finished=${this.growsFinished} amount=${ns.nFormat(this.growAmount, Formats.float)} per-sec=${ns.nFormat(this.growAmount / this.printEvery, Formats.float)} avg=${ns.nFormat(this.growAmount / this.growsFinished, Formats.float)}`);
        }
        if (this.weakensFinished > 0) {
            ns.print(`[weakens] finished=${this.weakensFinished} amount=${ns.nFormat(this.weakenAmount, Formats.float)} per-sec=${ns.nFormat(this.weakenAmount / this.printEvery, Formats.float)} avg=${ns.nFormat(this.weakenAmount / this.weakensFinished, Formats.float)}`);
        }
    }
}

export async function main(ns: NS): Promise<void> {
    ns.disableLog("ALL");

    ns.clearPort(Port.AutohackCommand);
    ns.clearPort(Port.AutohackResponse);

    const action = ns.args[0];
    if (action === 'deploy-workers') {
        await deployAllWorkers(ns);
    } else if (action === 'kill-workers') {
        await killWorkers(ns);
    } else if (action === 'hack') {
        await killWorkers(ns);
        const hostname = ns.args[1] as string;
        const workerCount = await deployAllWorkers(ns);

        const growRegistry = new JobRegistry(0.75);
        const weakenRegistry = new JobRegistry(0.75);
        const workerPool = new Pool(workerCount);

        //const targetMoneyRatio = ns.getServerMoneyAvailable(hostname) / ns.getServerMaxMoney(hostname);
        const targetMoneyRatio = 0.75;
        const targetSecurityLevel = ns.getServerMinSecurityLevel(hostname) + 5;

        const stats = new Stats(hostname, targetMoneyRatio, targetSecurityLevel);

        while (true) {
            for (const newServer of await purchaseWorkers(ns)) {
                const newWorkerCount = await deployWorkers(ns, newServer);
                workerPool.workers += newWorkerCount;
            }

            if (targetSecurityLevel < ns.getServerSecurityLevel(hostname)) {
                const weakenImpact = ns.weakenAnalyze(1, 1);
                const wantedCount = Math.ceil(((ns.getServerSecurityLevel(hostname) - targetSecurityLevel) / weakenImpact) * (ns.getWeakenTime(hostname) / ns.getHackTime(hostname)));
                const weakenTime = ns.getWeakenTime(hostname);
                const newJobCount = await weakenRegistry.want(ns, workerPool, wantedCount, weakenTime, { type: MessageType.Weaken, payload: hostname });
                if (newJobCount > 0) {
                    stats.recordWeaken(newJobCount);
                    //ns.print(`[scheduled] ${newJobCount}/${wantedCount} new weaken jobs for ${hostname} (time: ${ns.tFormat(weakenTime)})`);
                    //ns.print(`[security] ${ns.nFormat(ns.getServerSecurityLevel(hostname), Formats.float)} (target = ${targetSecurityLevel})`);
                }
            }

            const moneyRatio = ns.getServerMoneyAvailable(hostname) / ns.getServerMaxMoney(hostname);
            if (moneyRatio < targetMoneyRatio) {
                // available * x = max * TARGET
                // x = max * TARGET / available
                const wantedMultiplier = ns.getServerMaxMoney(hostname) * targetMoneyRatio / ns.getServerMoneyAvailable(hostname);
                const wantedCount = Math.ceil((ns.growthAnalyze(hostname, wantedMultiplier)) * (ns.getGrowTime(hostname) / ns.getHackTime(hostname)));
                const growTime = ns.getGrowTime(hostname);
                const newJobCount = await growRegistry.want(ns, workerPool, wantedCount, growTime, { type: MessageType.Grow, payload: hostname });
                if (newJobCount > 0) {
                    stats.recordGrow(newJobCount);
                    //ns.print(`[scheduled] ${newJobCount}/${wantedCount} new growth jobs for ${hostname} (time: ${ns.tFormat(growTime)})`);
                    //ns.print(`[money-ratio] ${ns.nFormat(moneyRatio, Formats.float)} (target = ${targetMoneyRatio})`);
                }
            }

            const hackTime = ns.getHackTime(hostname);
            const hacksWanted = Math.round(Math.max(10, Math.ceil(workerPool.workers / (hackTime / 1000))) * (moneyRatio / targetMoneyRatio));
            const hacksScheduled = await workerPool.submit(ns, hacksWanted, hackTime, { type: MessageType.Hack, payload: hostname });
            if (hacksScheduled > 0) {
                stats.recordHack(hacksScheduled);
                //ns.print(`[scheduled] ${hacksScheduled}/${hacksWanted} hack jobs against ${hostname} (time: ${ns.tFormat(hackTime)})`);
            }

            await stats.tick(ns);
            await ns.sleep(1000);
        }
    }
}