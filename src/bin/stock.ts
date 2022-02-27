import { NS } from '@ns';

import * as fmt from 'lib/fmt';

function score(ns: NS, symbol: string): number {
  return ns.stock.getForecast(symbol);
}

function findBest(ns: NS, print: (msg: string) => void): string | null {
  let target = null;

  for (const symbol of ns.stock.getSymbols()) {
    if (ns.stock.getMaxShares(symbol) === ns.stock.getPosition(symbol)[0]) {
      //print(`Already maxed out on ${target}, skipping`);
      continue;
    }
    if (target === null || score(ns, target) < score(ns, symbol)) {
      target = symbol;
    }
  }

  return target;
}

async function buyFor(ns: NS, money: number, print: (msg: string) => void): Promise<void> {
  let spent = 0;

  let n = 0;
  while (spent < money && n++ < 100) {
    const target = findBest(ns, print);
    if (target === null) {
      print('We already bought all the good stuff, top some up if you want manually');
      break;
    }

    const stonks =
      Math.min(Math.floor((money - spent) / ns.stock.getBidPrice(target)), ns.stock.getMaxShares(target)) -
      ns.stock.getPosition(target)[0];
    if (stonks <= 0) {
      print("Can't buy more o.0");
      break;
    }

    if (score(ns, target) < 0.5) {
      print(`Best stock to buy: ${target} has score ${score(ns, target)}. That's < 0.5, not buying`);
      break;
    }

    const buyin = stonks * ns.stock.getBidPrice(target);
    print(
      `Best stonk to buy: ${target} has score ${fmt.float(score(ns, target))}. Buying ${stonks} for ${fmt.money(
        buyin,
      )}`,
    );
    if (ns.stock.buy(target, stonks) > 0) {
      spent += buyin;
    }
  }

  if (!ns.isRunning(ns.getRunningScript().filename, ns.getHostname(), 'watch')) {
    print('Starting stock watcher');
    await ns.run(ns.getRunningScript().filename, 1, 'watch');
  }
}

export async function main(ns: NS): Promise<void> {
  fmt.init(ns);
  ns.disableLog('asleep');

  if (ns.args[0] === 'buy') {
    await buyFor(ns, fmt.parseMoney(ns.args[1] as string), ns.tprint.bind(ns));
  } else if (ns.args[0] === 'autobuy') {
    const downto = fmt.parseMoney(ns.args[1] as string);
    while (true) {
      const available = ns.getPlayer().money - downto;
      // TODO make this configurable. Maybe "downto" as well.
      if (available > 100000) {
        await buyFor(ns, available, ns.print.bind(ns));
      }
      await ns.asleep(5000);
    }
  } else if (ns.args[0] === 'watch') {
    const lastGains: { [symbol: string]: number } = {};
    let lastTotal = 0;

    while (true) {
      for (const symbol of ns.stock.getSymbols()) {
        const [stonks, avgPrice, ..._] = ns.stock.getPosition(symbol);
        //ns.print(`${symbol}: ${stonks} @ ${fmt.money(avgPrice)}`);
        if (stonks === 0) {
          continue;
        }
        const buyin = stonks * avgPrice;
        const gain = ns.stock.getSaleGain(symbol, stonks, 'Long') - buyin;
        if (!(symbol in lastGains) || lastGains[symbol] !== gain) {
          ns.print(`${symbol} Gain: ${fmt.money(gain)} (${fmt.percent(gain / buyin)})`);
          lastGains[symbol] = gain;
        }
        if (ns.stock.getForecast(symbol) < 0.5) {
          ns.print(`Selling ${stonks} ${symbol} for final gain of ${fmt.money(gain)}`);
          if (ns.stock.sell(symbol, stonks) > 0) {
            delete lastGains[symbol];
          }
        }
      }

      const total = Object.values(lastGains).reduce((a, b) => a + b, 0);
      if (total !== lastTotal) {
        ns.print(`Total Gain: ${fmt.money(total)}`);
        lastTotal = total;
      }

      await ns.asleep(1000);
    }
  }
}
