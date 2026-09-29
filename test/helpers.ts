import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { formatPublicKey, generateKeyPair, readKeyPair, writeKeyPair } from '../src/keys.js';

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls `condition` until it holds. A killed process lingers until it is reaped. */
export async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(25);
  }
}

/** Public key lines for `peers`, making `<dir>/<peer>.key` for any that has none yet. */
export async function keyLines(dir: string, peers: string[]): Promise<string[]> {
  return Promise.all(
    peers.map(async (peer) => {
      const path = join(dir, `${peer}.key`);
      await access(path).catch(() => writeKeyPair(path, generateKeyPair(), peer));
      return formatPublicKey(await readKeyPair(path), peer);
    }),
  );
}
