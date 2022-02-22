import { NS } from '@ns'
import { Port } from 'lib/constants';

export const enum MessageType {
    Hack,
    HackFinished,

    Weaken,
    WeakenFinished,

    Grow,
    GrowFinished,

    Shutdown
}

export interface Message {
    type: MessageType;
    payload: string;
}

export interface HackFinishedPayload {
    target: string;
    success: boolean;
    amount: number;
    duration: number;
}

export interface WeakenFinishedPayload {
    target: string;
    amount: number;
}

export interface GrowFinishedPayload {
    target: string;
    amount: number;
}

export function messageWithPayload<T>(type: MessageType, payload: T): Message {
    return { type, payload: JSON.stringify(payload) };
}

export function inflatePayload<T>(message: Message): T {
    return JSON.parse(message.payload);
}

export function hackFinished(target: string, success: boolean, amount: number, duration: number): Message {
    return messageWithPayload(MessageType.HackFinished, { target, success, amount, duration });
}

export function weakenFinished(target: string, amount: number): Message {
    return messageWithPayload(MessageType.WeakenFinished, { target, amount });
}

export function growFinished(target: string, amount: number): Message {
    return messageWithPayload(MessageType.GrowFinished, { target, amount });
}

export async function writeMessage(ns: NS, port: Port, message: Message): Promise<Message | null> {
    const popped = await ns.writePort(port.valueOf(), JSON.stringify(message));
    if (popped === null) {
        return null;
    }
    return JSON.parse(popped);
}

export async function readMessage(ns: NS, port: Port): Promise<Message | null> {
    const str = await ns.readPort(port.valueOf());
    if (str === "NULL PORT DATA") {
        return null;
    }
    return JSON.parse(str);
}