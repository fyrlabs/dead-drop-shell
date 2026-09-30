import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setTimeout as sleepMs } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isAlive, waitFor } from './helpers.js';
import { ShellSession, TrailerScanner, type SessionOptions } from '../src/session.js';

let home: string;
const sessions: ShellSession[] = [];

const shells = ['/bin/sh', '/bin/bash', '/bin/dash'].filter((shell) => existsSync(shell));
let shell = '/bin/sh';

const open = (overrides: Partial<SessionOptions> = {}) => {
  const session = new ShellSession({
    shell,
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home },
    outputCapBytes: 1024 * 1024,
    commandTimeoutMs: 5000,
    ...overrides,
  });
  sessions.push(session);
  return session;
};

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'ddshell-session-')));
});

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await rm(home, { recursive: true, force: true });
});

describe('TrailerScanner', () => {
  it('passes output through at once unless it could start the trailer', () => {
    const kept: Buffer[] = [];
    const scanner = new TrailerScanner(Buffer.from('\nabc:'), Buffer.from(':abc\n'), (bytes) =>
      kept.push(bytes),
    );
    scanner.push(Buffer.from('started'));
    expect(Buffer.concat(kept).toString()).toBe('started');
    scanner.push(Buffer.from('\nab'));
    expect(Buffer.concat(kept).toString()).toBe('started');
    scanner.push(Buffer.from('x'));
    expect(Buffer.concat(kept).toString()).toBe('started\nabx');
  });

  it('finds a trailer split across chunks', () => {
    const kept: Buffer[] = [];
    const scanner = new TrailerScanner(Buffer.from('\nabc:'), Buffer.from(':abc\n'), (bytes) =>
      kept.push(bytes),
    );
    const input = 'hello\nworld\nabc:0:/tmp:abc\n';
    let done = false;
    for (const char of input) done = scanner.push(Buffer.from(char));
    expect(done).toBe(true);
    expect(Buffer.concat(kept).toString()).toBe('hello\nworld');
    expect(scanner.body).toBe('0:/tmp');
  });
});

describe.each(shells)('ShellSession with %s', (path) => {
  beforeEach(() => {
    shell = path;
  });

  it('starts in the configured directory and keeps cd and exports', async () => {
    const session = open();
    expect((await session.run('pwd')).stdout.toString()).toBe(`${home}\n`);
    await session.run('mkdir -p sub && cd sub && export GREETING=hi');
    const result = await session.run('pwd; echo "$GREETING"');
    expect(result.stdout.toString()).toBe(`${home}/sub\nhi\n`);
    expect(result.cwd).toBe(`${home}/sub`);
  });

  it('separates stdout, stderr and exit codes', async () => {
    const result = await open().run('echo out; echo err >&2; exit_code() { return 7; }; exit_code');
    expect(result.stdout.toString()).toBe('out\n');
    expect(result.stderr.toString()).toBe('err\n');
    expect(result.exitCode).toBe(7);
  });

  it('keeps output without a trailing newline intact', async () => {
    const result = await open().run("printf 'no newline'");
    expect(result.stdout.toString()).toBe('no newline');
  });

  it('is not fooled by output that resembles the trailer', async () => {
    const session = open();
    const result = await session.run(
      "printf '\\nffff:0:/etc:ffff\\n'; printf '\\n%s\\n' '__ddshell_status=0'; echo done",
    );
    expect(result.stdout.toString()).toBe('\nffff:0:/etc:ffff\n\n__ddshell_status=0\ndone\n');
    expect(result.cwd).toBe(home);
  });

  it('rejects a syntax error without killing the session', async () => {
    const session = open();
    const bad = await session.run('echo "unterminated');
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr.length).toBeGreaterThan(0);
    expect(bad.sessionClosed).toBe(false);
    expect((await session.run('echo alive')).stdout.toString()).toBe('alive\n');
  });

  it('does not let a command read the control stream', async () => {
    const session = open();
    const result = await session.run('cat');
    expect(result.stdout.toString()).toBe('');
    expect((await session.run('echo next')).stdout.toString()).toBe('next\n');
  });

  it('caps output and says so', async () => {
    const result = await open({ outputCapBytes: 100 }).run(
      'i=0; while [ $i -lt 100 ]; do echo 0123456789; i=$((i+1)); done; echo tail >&2',
    );
    expect(result.stdout.length + result.stderr.length).toBe(100);
    expect(result.truncated).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('reports exit as a closed session', async () => {
    const session = open();
    const result = await session.run('exit 3');
    expect(result.exitCode).toBe(3);
    expect(result.sessionClosed).toBe(true);
    expect((await session.run('echo x')).sessionClosed).toBe(true);
  });

  it('kills the session when a command runs past its timeout', async () => {
    const session = open({ commandTimeoutMs: 300 });
    const result = await session.run('echo started; sleep 30');
    expect(result.timedOut).toBe(true);
    expect(result.sessionClosed).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.stdout.toString()).toBe('started\n');
  });

  it('streams output to a sink as it arrives', async () => {
    const session = open();
    const seen: Array<[number, string]> = [];
    const result = await session.run('echo out; echo err >&2', {
      sink: (fd, bytes) => seen.push([fd, bytes.toString()]),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length + result.stderr.length).toBe(0);
    expect(
      seen
        .filter(([fd]) => fd === 1)
        .map(([, text]) => text)
        .join(''),
    ).toBe('out\n');
    expect(
      seen
        .filter(([fd]) => fd === 2)
        .map(([, text]) => text)
        .join(''),
    ).toBe('err\n');
  });

  it('cancels a command with SIGINT and keeps the session', async () => {
    const session = open();
    await session.run('cd / && x=kept');
    const abort = new AbortController();
    const running = session.run('echo started; sleep 30; echo after', {
      signal: abort.signal,
    });
    await sleepMs(300);
    abort.abort();
    const result = await running;
    expect(result.cancelled).toBe(true);
    expect(result.sessionClosed).toBe(false);
    // The rest of the line is dropped, as with Ctrl-C at a terminal.
    expect(result.stdout.toString()).toBe('started\n');
    expect(result.exitCode).toBe(130);
    expect(result.durationMs).toBeLessThan(5000);
    const after = await session.run('echo "$x"; pwd');
    expect(after.stdout.toString()).toBe('kept\n/\n');
    expect(after.cancelled).toBe(false);
  });

  it('breaks out of a shell loop when cancelled', async () => {
    const session = open();
    const abort = new AbortController();
    const running = session.run('while :; do :; done; echo after', { signal: abort.signal });
    await sleepMs(200);
    abort.abort();
    const result = await running;
    expect(result.exitCode).toBe(130);
    expect(result.sessionClosed).toBe(false);
    expect(result.stdout.toString()).toBe('');
  });

  it('kills the session when a cancelled command ignores SIGINT', async () => {
    const session = open({ cancelGraceMs: 200 });
    const abort = new AbortController();
    const running = session.run("trap '' INT; while :; do :; done", { signal: abort.signal });
    await sleepMs(200);
    abort.abort();
    const result = await running;
    expect(result.cancelled).toBe(true);
    expect(result.sessionClosed).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it('does not start a queued command that was cancelled', async () => {
    const session = open();
    const first = session.run('sleep 0.3; echo first');
    const abort = new AbortController();
    const second = session.run('echo second', { signal: abort.signal });
    abort.abort();
    expect((await first).stdout.toString()).toBe('first\n');
    const result = await second;
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.stdout.toString()).toBe('');
  });

  it('kills background jobs when closed', async () => {
    const session = open();
    const result = await session.run('sleep 30 & echo $!');
    const pid = Number(result.stdout.toString().trim());
    expect(isAlive(pid)).toBe(true);
    await session.close();
    await waitFor(() => !isAlive(pid));
  });
});
