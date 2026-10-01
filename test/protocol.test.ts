import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { MAX_TTY_DIMENSION, parseRequest } from '../src/protocol.js';

describe('terminal requests', () => {
  const ttyId = randomUUID();

  it('parses open, io and close', () => {
    expect(
      parseRequest({ v: 1, op: 'tty-open', ttyId, cols: 80, rows: 24, term: 'xterm' }),
    ).toEqual({ v: 1, op: 'tty-open', ttyId, cols: 80, rows: 24, term: 'xterm' });
    expect(
      parseRequest({
        v: 1,
        op: 'tty-io',
        ttyId,
        inputOffset: 3,
        offset: 0,
        input: 'YQ==',
        cols: 9,
        rows: 5,
      }),
    ).toEqual({
      v: 1,
      op: 'tty-io',
      ttyId,
      inputOffset: 3,
      offset: 0,
      input: 'YQ==',
      cols: 9,
      rows: 5,
    });
    expect(parseRequest({ v: 1, op: 'tty-close', ttyId })).toEqual({
      v: 1,
      op: 'tty-close',
      ttyId,
    });
  });

  it('refuses what a pty cannot take', () => {
    const open = { v: 1, op: 'tty-open', ttyId, cols: 80, rows: 24 };
    const io = { v: 1, op: 'tty-io', ttyId, inputOffset: 0, offset: 0 };
    for (const bad of [
      { ...open, ttyId: 'nope' },
      { ...open, cols: 0 },
      { ...open, rows: MAX_TTY_DIMENSION + 1 },
      { ...open, cols: 1.5 },
      { ...open, term: 'x y' },
      { ...io, input: 5 },
      { ...io, inputOffset: -1 },
      { ...io, cols: 80 },
      { ...io, cols: 80, rows: 0 },
    ]) {
      expect(() => parseRequest(bad)).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }));
    }
  });
});

describe('forward requests', () => {
  const streamId = randomUUID();

  it('parses open, io and close', () => {
    const open = { v: 1, op: 'tcp-open', streamId, host: 'db.internal', port: 5432 };
    expect(parseRequest(open)).toEqual(open);
    const io = { v: 1, op: 'tcp-io', streamId, inputOffset: 2, offset: 0, input: 'YQ==' };
    expect(parseRequest(io)).toEqual(io);
    expect(parseRequest({ v: 1, op: 'tcp-close', streamId })).toEqual({
      v: 1,
      op: 'tcp-close',
      streamId,
    });
  });

  it('refuses bad ports, hosts and ids', () => {
    const open = { v: 1, op: 'tcp-open', streamId, host: 'db', port: 80 };
    for (const bad of [
      { ...open, port: 0 },
      { ...open, port: 65536 },
      { ...open, host: '' },
      { ...open, host: 'a\0b' },
      { ...open, streamId: 'x' },
    ]) {
      expect(() => parseRequest(bad)).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }));
    }
  });
});
