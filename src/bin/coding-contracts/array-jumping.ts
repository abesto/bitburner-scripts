import { NS } from '@ns';

export async function main(ns: NS): Promise<void> {
  /**
   * You are attempting to solve a Coding Contract. You have 1 tries remaining, after which the contract will self-destruct.

   * You are given the following array of integers:
   * 
   * 0,8,0,5,9,0,7,8,3,0,8,3,3,1,6,9
   * 
   * Each element in the array represents your MAXIMUM jump length at that position. This means that if you are at position i and your maximum jump length is n, you can jump to any position from i to i+n.
   * 
   * Assuming you are initially positioned at the start of the array, determine whether you are able to reach the last index.
   * 
   * Your answer should be submitted as 1 or 0, representing true and false respectively
   */

  const input = (ns.args[0] as string).split(',').map(s => parseInt(s));

  const reachable: Set<number> = new Set();
  const queue = [0];

  while (queue.length > 0) {
    const pos = queue.shift() as number;
    if (reachable.has(pos)) {
      continue;
    }
    for (let i = 1; i <= input[pos]; i++) {
      const next = pos + i;
      if (next >= input.length) {
        return ns.tprint(1);
      }
      queue.push(next);
    }
  }

  ns.tprint(0);
}
