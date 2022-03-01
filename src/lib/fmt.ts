import { NS } from '@ns';

import { Formats } from 'lib/constants';

const MoneySuffixes: { [suffix: string]: number } = {
  k: 3,
  m: 6,
  b: 9,
  t: 12,
};

export class Fmt {
  constructor(private ns: NS) {}

  money(n: number): string {
    return this.ns.nFormat(n, Formats.money);
  }

  float(n: number): string {
    return this.ns.nFormat(n, Formats.float);
  }

  time(t: number): string {
    return this.ns.tFormat(t);
  }

  keyValue(...items: [string, string][]): string {
    return items.map(([key, value]) => `${key}=${value}`).join(' ');
  }

  keyValueTabulated(...rows: [string, ...[string, string][]][]): string[] {
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
        `[${prefix.padStart(maxPrefixLength)}] ${fields
          .map((field, i) => field.padEnd(maxColumnLengths[i]))
          .join(' ')}`,
      );
    }

    return lines;
  }

  table(headers: string[], ...rows: string[][]): string[] {
    const maxColumnLengths = headers.map((header, i) => Math.max(header.length, ...rows.map(row => row[i].length)));

    return [
      headers.map((header, i) => header.padEnd(maxColumnLengths[i])).join('\t'),
      ...rows.map(row => row.map((field, i) => field.padEnd(maxColumnLengths[i])).join('\t')),
    ];
  }

  parseMoney(x: string | number): number {
    if (typeof x === 'string') {
      const [, num, suffix] = x.match(/^\$?([0-9.]+)([a-z]?)$/i) || [];
      return parseFloat(num) * 10 ** (MoneySuffixes[suffix] || 0);
    }
    return x;
  }

  percent(x: number): string {
    return `${Math.round(x * 100)}%`;
  }
}
