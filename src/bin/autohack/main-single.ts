import { NS } from '@ns'
import { discoverHackedHosts } from 'lib/distributed';
import { writeMessage, readMessage, MessageType, Message, inflatePayload, HackFinishedPayload, WeakenFinishedPayload, GrowFinishedPayload } from 'bin/autohack/messages';
import { Port, Formats } from 'lib/constants';

const TICK_LENGTH = 1000;

async function deployWorkers(ns: NS, hostname: string): Promise<number> {
    const script = '/bin/autohack/worker.js';
    const freeMem = ns.getServerMaxRam(hostname) - ns.getServerUsedRam(hostname);
    const reservedMem = hostname === ns.getHostname() ? parseInt(ns.read('/autohack/reserved-ram.txt') || '0') : 0;
    const workerCount = Math.floor((freeMem - reservedMem) / ns.getScriptRam(script));
    if (workerCount < 1) {
        return 0;
    }

    if (hostname !== ns.getHostname()) {
        await ns.scp(ns.ls(ns.getHostname(), '/bin'), hostname);
        await ns.scp(ns.ls(ns.getHostname(), '/lib'), hostname);
    }

    for (let i = 0; i < workerCount; i++) {
        // Yield before each exec to work around https://github.com/danielyxie/bitburner/issues/1714
        await ns.sleep(0);
        await ns.exec(script, hostname, 1, `${i}`);
    }

    ns.print(`Deployed ${workerCount} workers on ${hostname}`);
    return workerCount;
}

async function deployAllWorkers(ns: NS): Promise<number> {
    const hosts = discoverHackedHosts(ns);
    let sum = 0;
    for (const hostname of hosts) {
        sum += await deployWorkers(ns, hostname);
        await ns.sleep(0);
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

    count(hostname: string): number {
        return (this.ends[hostname] || []).length;
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

    async want(ns: NS, workerPool: Pool, count: number, length: number, splayOver: number, message: Message): Promise<number> {
        this.prune();
        const ends = this.ends[message.payload] || [];
        const existing = ends.length;
        const now = new Date().getTime();
        const toMax = count - existing;
        const splayed = Math.round(count / (splayOver / TICK_LENGTH));
        const want = Math.min(toMax, splayed, workerPool.workers * this.limit);
        if (want > 0) {
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
        //ns.print(`Not deleting weakest worker, it's too big: ${server} (${ns.getServerMaxRam(server)}GB > ${keep}GB)`);
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
        const hostname = ns.purchaseServer(`worker-${index}`, ram);
        workers.push(hostname);
        ns.print(`Purchased ${hostname} with ${ram}GB RAM`);
    }

    return workers;
}

class Stats {
    hacksInProgress = 0;
    hacksSucceeded = 0;
    hacksFailed = 0;
    hackedMoney = 0;
    hacksDuration = 0;

    growsInProgress = 0;
    growsFinished = 0;
    growAmount = 1.0;

    weakensInProgress = 0;
    weakensFinished = 0;
    weakenAmount = 0.0;

    seconds = 0;

    target: string
    targetMoneyRatio: number;
    targetSecurityLevel: number;
    periodSeconds: number;

    moneyRatios: number[] = [];
    securityLevels: number[] = [];

    constructor(target: string, targetMoneyRatio: number, targetSecurityLevel: number, periodSeconds: number) {
        this.target = target;
        this.targetMoneyRatio = targetMoneyRatio;
        this.targetSecurityLevel = targetSecurityLevel;
        this.periodSeconds = periodSeconds;
    }

    async tick(ns: NS): Promise<void> {
        await this.processPort(ns);
        this.recordServerState(ns);
        this.seconds += 1;
        if (this.seconds % this.periodSeconds === 0) {
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
        this.hacksDuration = 0;
        this.growsFinished = 0;
        this.growAmount = 1.0;
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
                    this.hacksDuration += payload.duration;
                } else {
                    this.hacksFailed += 1;
                }
                this.hacksInProgress -= 1;
            }

            if (message.type === MessageType.GrowFinished) {
                this.growsFinished += 1;
                this.growAmount *= inflatePayload<GrowFinishedPayload>(message).amount;
                this.growsInProgress -= 1;
            }

            if (message.type == MessageType.WeakenFinished) {
                this.weakensFinished += 1;
                this.weakenAmount += inflatePayload<WeakenFinishedPayload>(message).amount;
                this.growsInProgress -= 1;
            }
        }

        // Sometimes things get a bit weird, let's make them a bit less weird
        this.weakensInProgress = Math.max(0, this.weakensInProgress);
        this.hacksInProgress = Math.max(0, this.hacksInProgress);
        this.growsInProgress = Math.max(0, this.growsInProgress);
    }

    print(ns: NS): void {
        ns.print(`== Stats after ${ns.tFormat(this.seconds * 1000)} target:${this.target} ==`);
        ns.print(`[money-ratio] min=${ns.nFormat(Math.min(...this.moneyRatios), Formats.float)} max=${ns.nFormat(Math.max(...this.moneyRatios), Formats.float)} avg=${ns.nFormat(this.moneyRatios.reduce((a, b) => a + b, 0) / this.moneyRatios.length, Formats.float)} target=${ns.nFormat(this.targetMoneyRatio, Formats.float)}`);
        ns.print(`[   security] min=${ns.nFormat(Math.min(...this.securityLevels), Formats.float)} max=${ns.nFormat(Math.max(...this.securityLevels), Formats.float)} avg=${ns.nFormat(this.securityLevels.reduce((a, b) => a + b, 0) / this.securityLevels.length, Formats.float)} target=${ns.nFormat(this.targetSecurityLevel, Formats.float)}`);
        if (this.hacksInProgress > 0 || this.hacksSucceeded > 0 || this.hacksFailed > 0) {
            ns.print(`[      hacks] in-flight=${this.hacksInProgress} succeeded=${this.hacksSucceeded} failed=${this.hacksFailed} money=${ns.nFormat(this.hackedMoney, Formats.money)} per-sec=${ns.nFormat(this.hackedMoney / (this.hacksDuration / 1000), Formats.money)} avg=${ns.nFormat(this.hackedMoney / (this.hacksSucceeded + this.hacksFailed), Formats.money)}`);
        }
        if (this.growsFinished > 0 || this.growsInProgress > 0) {
            ns.print(`[      grows] in-flight=${this.growsInProgress} finished=${this.growsFinished} amount=${ns.nFormat(this.growAmount, Formats.float)} avg=${ns.nFormat(this.growAmount / this.growsFinished, Formats.float)}`);
        }
        if (this.weakensFinished > 0 || this.weakensInProgress > 0) {
            ns.print(`[    weakens] in-flight=${this.weakensInProgress} finished=${this.weakensFinished} amount=${ns.nFormat(this.weakenAmount, Formats.float)} per-sec=${ns.nFormat(this.weakenAmount / this.periodSeconds, Formats.float)} avg=${ns.nFormat(this.weakenAmount / this.weakensFinished, Formats.float)}`);
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
        const hackRegistry = new JobRegistry(1);
        const workerPool = new Pool(workerCount);

        //const targetMoneyRatio = ns.getServerMoneyAvailable(hostname) / ns.getServerMaxMoney(hostname);
        const targetMoneyRatio = 0.9;
        const targetSecurityLevel = ns.getServerMinSecurityLevel(hostname);

        const stats = new Stats(hostname, targetMoneyRatio, targetSecurityLevel, parseInt(ns.read("/autohack/stats-period.txt") || "10"));
        stats.recordServerState(ns);
        stats.print(ns);


        while (true) {
            const growTime = ns.getGrowTime(hostname);
            const hackTime = ns.getHackTime(hostname);
            const weakenTime = ns.getWeakenTime(hostname);
            const maxHackJobs = Math.ceil(ns.getServerMaxMoney(hostname) * (1 - targetMoneyRatio) / (ns.getServerMaxMoney(hostname) * ns.hackAnalyze(hostname) * ns.hackAnalyzeChance(hostname)));
            const moneyRatio = ns.getServerMoneyAvailable(hostname) / ns.getServerMaxMoney(hostname);
            const splayOver = Math.max(growTime, hackTime, weakenTime);

            const tickEnd = new Date().getTime() + TICK_LENGTH;

            for (const newServer of await purchaseWorkers(ns)) {
                const newWorkerCount = await deployWorkers(ns, newServer);
                workerPool.workers += newWorkerCount;
            }

            const moneyPerHack = ns.getServerMoneyAvailable(hostname) * ns.hackAnalyze(hostname) * ns.hackAnalyzeChance(hostname);
            if (moneyRatio >= targetMoneyRatio) {
                const targetAmount = ns.getServerMaxMoney(hostname) * (moneyRatio - targetMoneyRatio);
                const hacksWanted = Math.ceil(targetAmount / moneyPerHack);

                const hacksScheduled = await hackRegistry.want(ns, workerPool, hacksWanted, hackTime, splayOver, { type: MessageType.Hack, payload: hostname });
                if (hacksScheduled > 0) {
                    stats.recordHack(hacksScheduled);
                    //ns.print(`[scheduled] ${hacksScheduled}/${hacksWanted} hack jobs against ${hostname} (time: ${ns.tFormat(hackTime)})`);
                }
            }

            const moneyAfterHacks = ns.getServerMoneyAvailable(hostname) - moneyPerHack * hackRegistry.count(hostname);
            let wantGrow: number;
            if (moneyRatio < 1) {
                const wantedMultiplier = ns.getServerMaxMoney(hostname) / moneyAfterHacks;
                wantGrow = Math.ceil((ns.growthAnalyze(hostname, wantedMultiplier)));
            } else {
                wantGrow = 0;
            }


            const growSecurityCost = ns.growthAnalyzeSecurity(growRegistry.count(hostname));
            const hackSecurityCost = ns.hackAnalyzeSecurity(hackRegistry.count(hostname));
            const securityCost = growSecurityCost + hackSecurityCost;
            let wantWeaken: number;
            if (targetSecurityLevel < ns.getServerSecurityLevel(hostname) + securityCost) {
                const weakenImpact = ns.weakenAnalyze(1, 1);
                wantWeaken = Math.ceil(((ns.getServerSecurityLevel(hostname) + securityCost - targetSecurityLevel) / weakenImpact));
            } else {
                wantWeaken = 0;
            }

            const finalWeaken = Math.ceil((workerPool.workers - maxHackJobs) * (wantWeaken / (wantWeaken + wantGrow)));
            if (finalWeaken > 0) {
                const newJobCount = await weakenRegistry.want(ns, workerPool, finalWeaken, weakenTime, splayOver, { type: MessageType.Weaken, payload: hostname });
                if (newJobCount > 0) {
                    stats.recordWeaken(newJobCount);
                    //ns.print(`[scheduled] ${newJobCount}/${wantedCount} new weaken jobs for ${hostname} (time: ${ns.tFormat(weakenTime)})`);
                    //ns.print(`[security] ${ns.nFormat(ns.getServerSecurityLevel(hostname), Formats.float)} (target = ${targetSecurityLevel})`);
                }

            }

            const finalGrow = Math.ceil((workerPool.workers - maxHackJobs) * (wantGrow / (wantWeaken + wantGrow)));
            if (finalGrow > 0) {
                const newJobCount = await growRegistry.want(ns, workerPool, finalGrow, growTime, splayOver, { type: MessageType.Grow, payload: hostname });
                if (newJobCount > 0) {
                    stats.recordGrow(newJobCount);
                    //ns.print(`[scheduled] ${newJobCount}/${wantedCount} new growth jobs for ${hostname} (time: ${ns.tFormat(growTime)})`);
                    //ns.print(`[money-ratio] ${ns.nFormat(moneyRatio, Formats.float)} (target = ${targetMoneyRatio})`);
                }
            }

            while (new Date().getTime() < tickEnd) {
                await stats.processPort(ns);
                await ns.sleep(50);
            }
            await stats.tick(ns);
        }
    }
}