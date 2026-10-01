import { randomUUID } from 'node:crypto';

import { DeadDropError } from '@fyrlabs/dead-drop/protocol';
import { describe, expect, it } from 'vitest';

import type { ShellCall } from '../src/client.js';
import type { ShellRequest, TtyIoRequest, TtyOutput } from '../src/protocol.js';
import { RemoteTty } from '../src/tty-client.js';
import { waitFor } from './helpers.js';

/** A server that applies input by offset, as TtySession does, and can fail on demand. */
function fakeServer(failures: string[]) {
  let received = 0;
  let typed = '';
  const call = (async (_peer: string, request: ShellRequest) => {
    const io = request as TtyIoRequest;
    if (io.input !== undefined) {
      const failure = failures.shift();
      if (failure) throw new DeadDropError('TIMEOUT', failure);
      const bytes = Buffer.from(io.input, 'base64');
      const fresh = bytes.subarray(received - io.inputOffset);
      received += fresh.length;
      typed += fresh.toString();
    }
    // Reads hold until aborted, like a quiet screen.
    if (io.offset !== Number.MAX_SAFE_INTEGER)
      await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      ttyId: io.ttyId,
      state: 'running',
      offset: 0,
      frames: [],
      next: 0,
      end: 0,
      received,
    } satisfies TtyOutput;
  }) as unknown as ShellCall;
  return { call, typed: () => typed };
}

describe('RemoteTty', () => {
  it('resends keys after a timed-out request without typing them twice', async () => {
    const server = fakeServer(['no answer']);
    const tty = new RemoteTty(server.call, 'vm', randomUUID(), '/home');
    const stop = new AbortController();
    const attached = tty.attach({
      timeoutMs: 1000,
      signal: stop.signal,
      onOutput: () => undefined,
    });

    tty.type(Buffer.from('ab'));
    await waitFor(() => server.typed() === 'ab', 5000);
    tty.type(Buffer.from('c'));
    await waitFor(() => server.typed() === 'abc', 5000);

    stop.abort();
    expect(await attached).toBeUndefined();
    expect(server.typed()).toBe('abc');
  }, 15_000);

  it('gives up on an error a retry cannot cure', async () => {
    const call = (async () => {
      throw new DeadDropError('UNAUTHORIZED', 'not authorised');
    }) as unknown as ShellCall;
    const tty = new RemoteTty(call, 'vm', randomUUID(), '/home');
    await expect(tty.attach({ timeoutMs: 1000, onOutput: () => undefined })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
