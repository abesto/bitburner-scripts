import { NS } from '@ns'
import { Port } from 'lib/constants';

export const enum MessageType {
    HackRequest = 'hack-request',
    HackStarted = 'hack-started',
    HackFinished = 'hack-finished',

    WeakenRequest = 'weaken-request',
    WeakenStarted = 'weaken-started',
    WeakenFinished = 'weaken-finished',

    GrowRequest = 'grow-request',
    GrowStarted = 'grow-started',
    GrowFinished = 'grow-finished',

    Shutdown = 'shutdown',
}

export type Worker = {
    workerHost: string;
    workerIndex: number;
}

type RequestCommon = {
    target: string;
}

type StartedCommon = Worker & { target: string; }

type FinishedCommon = StartedCommon & { amount: number, duration: number };

export type Message =
    // Hack
    | { type: MessageType.HackRequest } & RequestCommon
    | { type: MessageType.HackStarted } & StartedCommon
    | { type: MessageType.HackFinished; success: boolean } & FinishedCommon
    // Weaken
    | { type: MessageType.WeakenRequest } & RequestCommon
    | { type: MessageType.WeakenStarted } & StartedCommon
    | { type: MessageType.WeakenFinished } & FinishedCommon
    // Grow
    | { type: MessageType.GrowRequest } & RequestCommon
    | { type: MessageType.GrowStarted } & StartedCommon
    | { type: MessageType.GrowFinished } & FinishedCommon
    // Shutdown
    | { type: MessageType.Shutdown };

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