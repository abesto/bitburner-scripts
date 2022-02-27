import { NS } from '@ns';

export async function main(ns: NS): Promise<void> {
  // You are given the following array of stock prices (which are numbers) where the i-th element represents the stock
  // price on day i:
  // $INPUT
  // Determine the maximum possible profit you can earn using at most one transaction (i.e. you can only buy and sell
  // the stock once). If no profit can be made then the answer should be 0. Note that you have to buy the stock before
  // you can sell it

  const prices = (ns.args[0] as string).split(',').map(x => parseInt(x));
  let answer = 0;
  for (let i = 0; i < prices.length; i++) {
    for (let j = i + 1; j < prices.length; j++) {
      answer = Math.max(answer, prices[j] - prices[i]);
    }
  }
  ns.tprint(answer);
}
