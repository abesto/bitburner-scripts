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
