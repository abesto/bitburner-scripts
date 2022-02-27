import { NS } from '@ns';

import { Formats } from 'lib/constants';

let _ns: NS;

export function init(ns: NS) {
  _ns = ns;
}

export function money(n: number): string {
  return _ns.nFormat(n, Formats.money);
}

export function float(n: number): string {
  return _ns.nFormat(n, Formats.float);
}

export function time(t: number): string {
  return _ns.tFormat(t);
}

export function keyValue(...items: [string, string][]): string {
  return items.map(([key, value]) => `${key}=${value}`).join(' ');
}

export function keyValueTabulated(...rows: [string, ...[string, string][]][]): string[] {
  const strRows: [string, string[]][] = rows.map(([prefix, ...fields]) => [
    prefix,
    fields.map(([key, value]) => `${key}=${value}`),
  ]);

  const maxColumnLengths: number[] = strRows.reduce((acc, [_, fields]) => {
    fields.forEach((field, i) => {
      acc[i] = Math.max(acc[i] || 0, field.length);
    });
    return acc;
  }, [] as number[]);

  const maxPrefixLength = rows.reduce((acc, [prefix, _]) => Math.max(acc, prefix.length), 0);

  const lines: string[] = [];
  for (const [prefix, fields] of strRows) {
    lines.push(
      `[${prefix.padStart(maxPrefixLength)}] ${fields.map((field, i) => field.padEnd(maxColumnLengths[i])).join(' ')}`,
    );
  }

  return lines;
}

export function table(headers: string[], ...rows: string[][]): string[] {
  const maxColumnLengths = headers.map((header, i) => Math.max(header.length, ...rows.map(row => row[i].length)));

  return [
    headers.map((header, i) => header.padEnd(maxColumnLengths[i])).join('\t'),
    ...rows.map(row => row.map((field, i) => field.padEnd(maxColumnLengths[i])).join('\t')),
  ];
}

const MoneySuffixes: { [suffix: string]: number } = {
  k: 3,
  m: 6,
  b: 9,
  t: 12,
};
export function parseMoney(x: string | number): number {
  if (typeof x === 'string') {
    const [, num, suffix] = x.match(/^\$?([0-9.]+)([a-z]?)$/i) || [];
    return parseFloat(num) * 10 ** (MoneySuffixes[suffix] || 0);
  }
  return x;
}

export function percent(x: number): string {
  return `${Math.round(x * 100)}%`;
}
