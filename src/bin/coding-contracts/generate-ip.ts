import { NS } from '@ns';

// this no worky worky

export async function main(ns: NS): Promise<void> {
  /*
  You are attempting to solve a Coding Contract. You have 10 tries remaining, after which the contract will self-destruct.

  Given the following string containing only digits, return an array with all possible valid IP address combinations that can be created from the string:

  $INPUT

  Note that an octet cannot begin with a '0' unless the number itself is actually 0. For example, '192.168.010.1' is not a valid IP.

  Examples:

  25525511135 -> [255.255.11.135, 255.255.111.35]
  1938718066 -> [193.87.180.66]
  */
  const input = ns.args[0].toString();
  const answer = [];
  const dots = [1, 2, 3];

  while (true) {
    const ip = toIp(input, dots);
    ns.tprint(ip);
    if (isValidIpAddress(ip)) {
      answer.push(ip);
    }
    if (!advance(dots)) {
      break;
    }
  }
  ns.tprint(`[${answer.join(', ')}]`);
}

function advance(dots: number[]): boolean {
  let i = dots.length - 1;
  while (i >= 0) {
    dots[i]++;
    if (dots[i] > 3) {
      dots[i] = 1;
      i--;
      return true;
    } else {
      return false;
    }
  }
  return false;
}

function toIp(input: string, dots: number[]): string {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const from = i === 0 ? 0 : dots[i - 1];
    const part = input.substring(from, dots[i]);
    parts.push(part);
  }
  return parts.join('.');
}

function isValidIpAddress(s: string): boolean {
  const parts = s.split('.');
  if (parts.length !== 4) {
    return false;
  }
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!isValidOctet(part)) {
      return false;
    }
  }
  return true;
}

function isValidOctet(s: string): boolean {
  const part = parseInt(s);
  if (s.length > 3 || s.length < 1) {
    return false;
  }
  if (s.length === 3 && s[0] === '0') {
    return false;
  }
  if (s.length === 1 && part > 7) {
    return false;
  }
  if (s.length === 2 && part > 99) {
    return false;
  }
  if (s.length === 3 && part > 255) {
    return false;
  }
  return true;
}
