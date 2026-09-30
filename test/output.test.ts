import { describe, expect, it } from 'vitest';

import { OutputBuffer, readStored } from '../src/output.js';

const text = (frames: Array<{ fd: number; data: string }>) =>
  frames.map(({ fd, data }) => `${fd}:${Buffer.from(data, 'base64').toString()}`);

describe('OutputBuffer', () => {
  it('keeps stdout and stderr in order and merges neighbours from one stream', () => {
    const buffer = new OutputBuffer(1024);
    buffer.append(1, Buffer.from('a'));
    buffer.append(1, Buffer.from('b'));
    buffer.append(2, Buffer.from('E'));
    buffer.append(1, Buffer.from('c'));
    const all = buffer.read(0);
    expect(text(all.frames)).toEqual(['1:ab', '2:E', '1:c']);
    expect(all).toMatchObject({ offset: 0, next: 4, end: 4 });
    expect(text(buffer.read(1).frames)).toEqual(['1:b', '2:E', '1:c']);
    expect(text(buffer.read(1, 2).frames)).toEqual(['1:b', '2:E']);
    expect(buffer.read(4).frames).toEqual([]);
  });

  it('keeps only the latest capBytes and says where they start', () => {
    const buffer = new OutputBuffer(4);
    buffer.append(1, Buffer.from('abc'));
    buffer.append(2, Buffer.from('def'));
    const slice = buffer.read(0);
    expect(slice.offset).toBe(2);
    expect(text(slice.frames)).toEqual(['1:c', '2:def']);
    const stored = buffer.snapshot();
    expect(stored.start).toBe(2);
    expect(readStored(stored, 3)).toMatchObject({ offset: 3, next: 6, end: 6 });
    expect(text(readStored(stored, 0).frames)).toEqual(['1:c', '2:def']);
  });

  it('wakes a waiter on output or close, and otherwise after the wait', async () => {
    const buffer = new OutputBuffer(1024);
    const waiting = buffer.waitFor(0, 10_000);
    buffer.append(1, Buffer.from('x'));
    await waiting;
    const started = Date.now();
    await buffer.waitFor(1, 50);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    const closing = buffer.waitFor(1, 10_000);
    buffer.close();
    await closing;
  });
});
