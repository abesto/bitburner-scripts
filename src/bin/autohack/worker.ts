import { NS } from '@ns'
import { Port } from 'lib/constants';
import { readMessage, writeMessage, MessageType, Message, hackFinished, weakenFinished, growFinished } from 'bin/autohack/messages';

async function send(ns: NS, messageIn: Message): Promise<void> {
    let message: Message | null = messageIn;
    while (true) {
        message = await writeMessage(ns, Port.AutohackResponse, message);
        if (message === null) {
            break;
        }
        ns.print("Resend :(");
        await ns.sleep(Math.random() * 500);
    }
}

export async function main(ns: NS): Promise<void> {
    ns.disableLog("sleep");

    while (true) {
        const message = await readMessage(ns, Port.AutohackCommand);

        if (message === null) {
            await ns.sleep(100);
            continue;
        }

        if (message.type === MessageType.Hack) {
            const start = new Date().getTime();
            const amount = await ns.hack(message.payload);
            const end = new Date().getTime();
            const duration = end - start;
            await send(ns, hackFinished(message.payload, amount > 0, amount, duration));
        } else if (message.type === MessageType.Weaken) {
            const amount = await ns.weaken(message.payload);
            await send(ns, weakenFinished(message.payload, amount));
        } else if (message.type === MessageType.Grow) {
            const amount = await ns.grow(message.payload);
            await send(ns, growFinished(message.payload, amount));
        } else if (message.type === MessageType.Shutdown) {
            break;
        }
    }
}