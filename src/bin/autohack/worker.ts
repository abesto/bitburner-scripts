import { NS } from '@ns'
import { Port } from 'lib/constants';
import { readMessage, writeMessage, MessageType, hackFinished, weakenFinished, growFinished } from 'bin/autohack/messages';

export async function main(ns: NS): Promise<void> {
    ns.disableLog("sleep");

    while (true) {
        const message = await readMessage(ns, Port.AutohackCommand);

        if (message === null) {
            await ns.sleep(100);
            continue;
        }

        if (message.type === MessageType.Hack) {
            const amount = await ns.hack(message.payload);
            await writeMessage(ns, Port.AutohackResponse, hackFinished(message.payload, amount === 0, amount));
        } else if (message.type === MessageType.Weaken) {
            const amount = await ns.weaken(message.payload);
            await writeMessage(ns, Port.AutohackResponse, weakenFinished(message.payload, amount));
        } else if (message.type === MessageType.Grow) {
            const amount = await ns.grow(message.payload);
            await writeMessage(ns, Port.AutohackResponse, growFinished(message.payload, amount));
        } else if (message.type === MessageType.Shutdown) {
            break;
        }
    }
}