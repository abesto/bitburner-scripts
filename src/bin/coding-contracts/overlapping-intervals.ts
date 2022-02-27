import { NS } from '@ns';

export async function main(ns: NS): Promise<void> {
  // Given the following array of array of numbers representing a list of intervals, merge all overlapping intervals.
  // The intervals must be returned in ASCENDING order. You can assume that in an interval, the first number will always
  // be smaller than the second.
  const input: [number, number][] = JSON.parse(ns.args[0] as string);
  input.sort((a, b) => a[0] - b[0]);

  const answer = [];
  for (let i = 0; i < input.length; i++) {
    const interval = input[i];
    const start = interval[0];
    const end = interval[1];
    if (answer.length === 0 || answer[answer.length - 1][1] < start) {
      answer.push(interval);
    } else {
      answer[answer.length - 1][1] = Math.max(answer[answer.length - 1][1], end);
    }
  }
  ns.tprint(JSON.stringify(answer));
}
