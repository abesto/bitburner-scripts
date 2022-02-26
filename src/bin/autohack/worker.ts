import { NS } from '@ns';

import {
  Message,
  MessageType as MT,
  readMessage,
  writeMessage,
} from 'lib/autohack/messages';
import { Port } from 'lib/constants';
import { timed } from 'lib/time';

const splay = Math.random() * 100;

async function send(ns: NS, messageIn: Message): Promise<void> {
  let message: Message | null = messageIn;
  while (true) {
    message = await writeMessage(ns, Port.AutohackResponse, message);
    if (message === null) {
      break;
    }
    ns.print('Resend :(');
    await ns.asleep(Math.random() * splay);
  }
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog('sleep');
  const workerIndex = parseInt(ns.args[0] as string);
  const workerData = { workerHost: ns.getHostname(), workerIndex };

  while (true) {
    const message = await readMessage(ns, Port.AutohackCommand);

    if (message === null) {
      await ns.asleep(100 + splay);
      continue;
    }

    if (message.type === MT.HackRequest) {
      const target = message.target;
      await send(ns, { type: MT.HackStarted, target, ...workerData });
      const { retval: amount, duration } = await timed(ns.hack(target));
      await send(ns, { type: MT.HackFinished, target, success: amount > 0, amount, duration, ...workerData });
    } else if (message.type === MT.WeakenRequest) {
      const target = message.target;
      await send(ns, { type: MT.WeakenStarted, target, ...workerData });
      const { retval: amount, duration } = await timed(ns.weaken(target));
      await send(ns, { type: MT.WeakenFinished, target, amount, duration, ...workerData });
    } else if (message.type === MT.GrowRequest) {
      const target = message.target;
      await send(ns, { type: MT.GrowStarted, target, ...workerData });
      const { retval: amount, duration } = await timed(ns.grow(target));
      await send(ns, { type: MT.GrowFinished, target, amount, duration, ...workerData });
    } else if (message.type === MT.Shutdown) {
      break;
    } else {
      ns.print(`Unknown message: ${JSON.stringify(message)}`);
    }
  }
}
