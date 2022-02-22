import { NS } from '@ns'

export async function timed<R>(p: Promise<R>): Promise<{ duration: number, retval: R }> {
    const start = Date.now();
    const retval = await p;
    return { duration: Date.now() - start, retval };
}