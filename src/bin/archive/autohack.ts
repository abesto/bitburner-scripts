import { NS } from '@ns'

export async function main(ns: NS): Promise<void> {
    const hostname = ns.args[0] as string;
    const threads = ns.args[1] as number;

    while (true) {
        while (ns.hackAnalyzeChance(hostname) < 0.7 && ns.getServerMinSecurityLevel(hostname) + 1 < ns.getServerSecurityLevel(hostname)) {
            await ns.weaken(hostname);
        }

        const moneyAvailable = ns.getServerMoneyAvailable(hostname);
        const hackRatio = ns.hackAnalyze(hostname);
        const hackChance = ns.hackAnalyzeChance(hostname);
        const hackTime = ns.getHackTime(hostname);

        const hackIncome = moneyAvailable * hackRatio;
        const hackValue = hackIncome * hackChance / hackTime;
        ns.print(`${hostname} hack income: ${hackIncome} hack time: ${hackTime} hack value: ${hackValue}`);

        if (hackIncome === 0) {
            await ns.sleep(10000);
            ns.print('Hack income zero, sleeping for a bit and trying again');
            continue;
        }

        const growTime = ns.getGrowTime(hostname);

        // hackIncomePostGrow = (moneyAvailable + breakevenGrowth) * hackRatio
        // hackPlusGrowValue = hackIncomePostGrow * hackChance / (growTime + hackTime)
        //                   = ((moneyAvailable + breakevenGrowth) * hackRatio) * hackChance / (growTime + hackTime)
        // we want to grow if
        //  hackValue < hackPlusGrowValue
        //  moneyAvailable * hackRatio * hackChance / hackTime < ((moneyAvailable + breakevenGrowth) * hackRatio) * hackChance / (growTime + hackTime)
        //  moneyAvailable * hackRatio * hackChance / hackTime < (moneyAvailable + breakevenGrowth) * hackRatio * hackChance / (growTime + hackTime)
        //                           moneyAvailable / hackTime < (moneyAvailable + breakevenGrowth) / (growTime + hackTime)
        // (moneyAvailable * (growTime + hackTime)) / hackTime < moneyAvailable + breakevenGrowth
        // (moneyAvailable * (growTime + hackTime)) / hackTime - moneyAvailable < breakevenGrowth
        // (moneyAvailable * (growTime + hackTime) - (moneyAvailable * hackTime)) / hackTime < breakevenGrowth
        // (moneyAvailable * (growTime + hackTime - hackTime)) / hackTime < breakevenGrowth
        // (moneyAvailable * growTime) / hackTime < breakevenGrowth

        const breakevenGrowth = moneyAvailable * growTime / hackTime;
        const breakevenRatio = (moneyAvailable + breakevenGrowth) / moneyAvailable;
        const growsNeeded = ns.growthAnalyze(hostname, breakevenRatio);
        ns.print(`${hostname} breakevenGrowth: ${breakevenGrowth} grows needed: ${growsNeeded} grow time: ${growTime}`);

        if (growsNeeded < 2) {
            await ns.grow(hostname);
        } else {
            await ns.hack(hostname, { threads });
        }
    }
}