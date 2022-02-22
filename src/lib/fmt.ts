import { NS } from '@ns'

import { Formats } from 'lib/constants'

export function money(ns: NS, n: number): string {
    return ns.nFormat(n, Formats.money);
}

export function float(ns: NS, n: number): string {
    return ns.nFormat(n, Formats.float);
}

export function time(ns: NS, t: number): string {
    return ns.tFormat(t);
}