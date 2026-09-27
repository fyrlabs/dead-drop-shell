import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JobLedger } from '../src/ledger.js';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ddshell-ledger-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const record = (fields: Partial<Parameters<JobLedger<string>['put']>[0]> = {}) => ({
  jobId: randomUUID(),
  identity: 'laptop',
  sessionId: randomUUID(),
  state: 'running' as const,
  startedAt: 1000,
  ...fields,
});

describe('JobLedger', () => {
  it('marks interrupted jobs unknown on open and keeps finished ones', async () => {
    const first = new JobLedger<string>(directory, 60_000, () => 2000);
    await first.open();
    const running = record();
    const done = record({ state: 'completed', result: 'ok', finishedAt: 1500 });
    await first.put(running);
    await first.put(done);

    const second = new JobLedger<string>(directory, 60_000, () => 3000);
    expect(await second.open()).toEqual({ recovered: [running.jobId] });
    expect((await second.get(running.jobId))?.state).toBe('unknown');
    expect(await second.get(done.jobId)).toEqual(done);
  });

  it('prunes finished records past retention but never running ones', async () => {
    let now = 1000;
    const ledger = new JobLedger<string>(directory, 500, () => now);
    await ledger.open();
    const running = record({ startedAt: 0 });
    const old = record({ state: 'completed', finishedAt: 100 });
    const fresh = record({ state: 'completed', finishedAt: 900 });
    for (const entry of [running, old, fresh]) await ledger.put(entry);
    now = 1000;
    expect(await ledger.prune()).toBe(1);
    expect(await ledger.get(old.jobId)).toBeUndefined();
    expect(await ledger.get(fresh.jobId)).toBeDefined();
    expect(await ledger.get(running.jobId)).toBeDefined();
  });

  it('discards a write interrupted before its rename', async () => {
    const ledger = new JobLedger<string>(directory, 60_000);
    await ledger.open();
    await writeFile(join(directory, `${randomUUID()}.json.tmp`), '{"half');
    await ledger.open();
    expect(await readdir(directory)).toEqual([]);
  });

  it('leaves a write in progress alone when pruning', async () => {
    const ledger = new JobLedger<string>(directory, 60_000);
    await ledger.open();
    const pending = `${randomUUID()}.json.tmp`;
    await writeFile(join(directory, pending), '{"half');
    await ledger.prune();
    expect(await readdir(directory)).toEqual([pending]);
  });

  it('refuses ids that are not UUIDs', async () => {
    const ledger = new JobLedger<string>(directory, 60_000);
    await ledger.open();
    expect(await ledger.get('../../etc/passwd')).toBeUndefined();
    await expect(ledger.put(record({ jobId: '../x' }))).rejects.toThrow(/invalid job id/);
  });
});
