import { NS } from '@ns';

export async function main(ns: NS): Promise<void> {
  /*
  Given the following string:
  
  ()aa((a)())(
  
  remove the minimum number of invalid parentheses in order to validate the string. If there are multiple minimal ways to
  validate the string, provide all of the possible results. The answer should be provided as an array of strings. If it is
  impossible to validate the string the result should be an array with only an empty string.
  
  IMPORTANT: The string may contain letters, not just parentheses. Examples:
  "()())()" -> [()()(), (())()]
  "(a)())()" -> [(a)()(), (a())()]
  ")( -> [""]
  */

  const input = ns.args[0] as string;
  const answer = removeInvalidParentheses(input);
  ns.tprint(`[${answer.join(', ')}]`);
}

function removeInvalidParentheses(input: string): string[] {
  let answer: string[] = [];
  const queue: [number, number][] = [[0, input.length - 1]];
  while (queue.length > 0) {
    const [start, end] = queue.shift()!;
    if (isValid(input.substring(start, end + 1))) {
      answer.push(input.substring(start, end + 1));
    } else {
      for (let i = start; i <= end; i++) {
        if (input[i] === '(' || input[i] === ')') {
          queue.push([start, i - 1], [i + 1, end]);
        }
      }
    }
  }
  // Make answers unique and remove the empty string
  answer = [...new Set(answer)].filter(x => x !== '');
  // Restrict to only those answers with the fewest number of parentheses removed compared to input
  const withCounts: [string, number][] = answer.map(x => [x, countParens(x)]);
  const maxCount = withCounts.reduce((acc, x) => Math.max(acc, x[1]), 0);
  answer = withCounts.filter(x => x[1] === maxCount).map(x => x[0]);
  return answer;
}

function isValid(input: string): boolean {
  let balance = 0;
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '(') {
      balance++;
    } else if (input[i] === ')') {
      balance--;
    }
    if (balance < 0) {
      return false;
    }
  }
  return balance === 0;
}

function countParens(s: string): number {
  return s.split('').reduce((acc, x) => {
    if (x === '(' || x == ')') {
      acc++;
    }
    return acc;
  }, 0);
}
