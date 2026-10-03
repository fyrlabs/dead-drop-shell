import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeadDropError, generateWorkspaceSecret } from '@fyrlabs/dead-drop/protocol';
import {
  DeadDropRuntime,
  parseRuntimeConfig,
  type RuntimeConfig,
} from '@fyrlabs/dead-drop/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ShellServer } from '../src/server.js';
import { ShellClient, type RemoteSession } from '../src/client.js';
import { parseShellConfig, type ShellConfig } from '../src/config.js';
import { formatPublicKey, parsePublicKey, readKeyPair } from '../src/keys.js';
import { JobLedger } from '../src/ledger.js';
import {
  isJobId,
  namedSessionId,
  type ExecResponse,
  type JobResult,
  type ShellRequest,
  type TcpLost,
  type TcpOpened,
  type TcpOutput,
  type TtyLost,
  type TtyOpened,
  type TtyOutput,
} from '../src/protocol.js';
import { isAlive, keyLines, ptyInstalled, waitFor } from './helpers.js';

let root: string;
let home: string;
let secret: string;
const cleanup: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ddshell-it-')));
  home = join(root, 'home');
  await mkdir(home);
  secret = generateWorkspaceSecret();
});

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  await rm(root, { recursive: true, force: true });
});

function runtimeConfig(peerId: string): RuntimeConfig {
  return parseRuntimeConfig({
    dataDir: join(root, `${peerId}-state`),
    logLevel: 'silent',
    workspaces: [
      {
        name: 'shell',
        peerId,
        secrets: [secret],
        transports: [{ use: 'filesystem', config: { root: join(root, 'store') } }],
        polling: { minIntervalMs: 20, maxIntervalMs: 100 },
      },
    ],
  });
}

function shellConfig(runtime: RuntimeConfig, fields: Record<string, unknown> = {}): ShellConfig {
  return parseShellConfig(
    {
      targets: { vm: 'vm' },
      key: join(root, `${runtime.workspaces[0]!.peerId}.key`),
      knownHosts: join(root, `${runtime.workspaces[0]!.peerId}.known_hosts`),
      hostKey: join(root, `${runtime.workspaces[0]!.peerId}.host_key`),
      ...fields,
    },
    runtime,
    root,
  );
}

async function startServer(fields: Record<string, unknown> = {}): Promise<ShellServer> {
  const runtime = runtimeConfig('vm');
  // Tests name controllers by peer id; each gets its own key.
  const { allowControllers = ['laptop'], ...rest } = fields as { allowControllers?: string[] };
  const authorizedKeys = await keyLines(root, allowControllers);
  const server = await ShellServer.start({
    runtime,
    shell: shellConfig(runtime, { authorizedKeys, allowControllers, ...rest }),
    home,
  });
  cleanup.push(() => server.stop());
  return server;
}

/** `v1` leaves the controller without a key, so it speaks protocol v1. */
async function startClient(
  peerId = 'laptop',
  { v1 = false, ...fields }: { v1?: boolean } & Record<string, unknown> = {},
): Promise<ShellClient> {
  const runtime = runtimeConfig(peerId);
  if (!v1) await keyLines(root, [peerId]);
  const shell = shellConfig(runtime, {
    ...(v1 ? { key: join(root, `${peerId}.nokey`) } : {}),
    ...fields,
  });
  const client = await ShellClient.start({ runtime, shell });
  cleanup.push(() => client.stop());
  return client;
}

function completed(response: ExecResponse): JobResult & { out: string; err: string } {
  if (response.state === 'session_lost') throw new Error(`session lost: ${response.message}`);
  return {
    ...response,
    out: Buffer.from(response.stdout, 'base64').toString(),
    err: Buffer.from(response.stderr, 'base64').toString(),
  };
}

const run = async (session: RemoteSession, command: string, jobId?: string) =>
  completed(await session.exec(command, { timeoutMs: 10_000, ...(jobId ? { jobId } : {}) }));

describe('ddshell over the filesystem transport', () => {
  it('starts in the home directory and keeps cd and exported variables', async () => {
    await startServer();
    const session = (await startClient()).session('vm');

    const first = await run(session, 'pwd');
    expect(first.out).toBe(`${home}\n`);
    expect(first.cwd).toBe(home);
    expect(first.home).toBe(home);

    await run(session, `mkdir -p app && cd app && export STAGE=test`);
    const after = await run(session, 'pwd; echo "$STAGE"');
    expect(after.out).toBe(`${home}/app\ntest\n`);
    expect(after.cwd).toBe(`${home}/app`);
  });

  it('keeps sessions independent and runs them concurrently', async () => {
    await startServer();
    const client = await startClient();
    const one = client.session('vm');
    const two = client.session('vm');

    await run(one, 'cd / && export WHO=one');
    const second = await run(two, 'pwd; echo "${WHO:-unset}"');
    expect(second.out).toBe(`${home}\nunset\n`);

    // One can only finish after two runs, so this deadlocks if sessions are serialised.
    const flag = join(home, 'go');
    const [waited, touched] = await Promise.all([
      run(one, `until [ -e '${flag}' ]; do sleep 0.05; done; echo waited`),
      run(two, `touch '${flag}'`),
    ]);
    expect(waited.out).toBe('waited\n');
    expect(touched.exitCode).toBe(0);
  });

  it('returns stdout, stderr, exit code and duration', async () => {
    await startServer();
    const session = (await startClient()).session('vm');
    const result = await run(session, 'echo out; echo err >&2; false');
    expect(result).toMatchObject({ out: 'out\n', err: 'err\n', exitCode: 1, state: 'completed' });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.replayed).toBe(false);
    expect((await run(session, 'exit 0')).exitCode).toBe(0);
  });

  it('passes through output that imitates the protocol', async () => {
    await startServer();
    const session = (await startClient()).session('vm');
    const imitation = '\\n0123abcd:0:/etc:0123abcd\\n{"v":1,"op":"close"}';
    const result = await run(session, `printf '${imitation}'`);
    expect(result.out).toBe('\n0123abcd:0:/etc:0123abcd\n{"v":1,"op":"close"}');
    expect(result.cwd).toBe(home);
  });

  it('caps output and marks it truncated', async () => {
    await startServer({ outputCapBytes: 64 });
    const session = (await startClient()).session('vm');
    const result = await run(session, 'head -c 10000 /dev/zero | tr "\\0" x');
    expect(result.out).toBe('x'.repeat(64));
    expect(result.truncated).toBe(true);
  });

  it('kills a command past its timeout and reports the session closed', async () => {
    await startServer({ commandTimeoutMs: 300 });
    const session = (await startClient()).session('vm');
    const result = await run(session, 'sleep 30');
    expect(result).toMatchObject({ timedOut: true, sessionClosed: true, exitCode: null });
    const next = await session.exec('echo again', { timeoutMs: 10_000 });
    expect(next.state).toBe('session_lost');
  });

  it('closes idle sessions and refuses to silently replace them', async () => {
    await startServer({ idleTimeoutMs: 200 });
    const session = (await startClient()).session('vm');
    await run(session, 'cd /');
    await new Promise((resolve) => setTimeout(resolve, 600));
    const next = await session.exec('touch should-not-exist', { timeoutMs: 10_000 });
    expect(next.state).toBe('session_lost');
    await expect(readFile(join(home, 'should-not-exist'))).rejects.toThrow();
  });

  it('kills session shells and their background jobs on server shutdown', async () => {
    const server = await startServer();
    const session = (await startClient()).session('vm');
    const background = Number((await run(session, 'sleep 30 & echo $!')).out.trim());
    const shells = server.sessionPids();
    expect(shells).toHaveLength(1);
    await server.stop();
    await waitFor(() => !isAlive(background) && shells.every((pid) => !isAlive(pid)));
  });

  it('refuses a controller that is not allowed, by identity', async () => {
    await startServer();
    const intruder = (await startClient('mallory')).session('vm');
    const error = await intruder
      .exec('touch pwned', { timeoutMs: 10_000 })
      .catch((caught: unknown) => caught);
    expect(DeadDropError.is(error) && error.code).toBe('UNAUTHORIZED');
    await expect(readFile(join(home, 'pwned'))).rejects.toThrow();
  });

  it('keeps another channel on the workspace answering while a command runs', async () => {
    // Workspace concurrency 1: without the shell's own lane, the running command
    // would hold the only handler slot and the probe would wait for it.
    const runtime = runtimeConfig('vm');
    const server = await ShellServer.start({
      runtime: {
        ...runtime,
        workspaces: runtime.workspaces.map((w) => ({ ...w, concurrency: 1 })),
      },
      shell: shellConfig(runtime, {
        authorizedKeys: await keyLines(root, ['laptop']),
        allowControllers: ['laptop'],
      }),
      home,
    });
    cleanup.push(() => server.stop());
    server.runtime.workspace('shell').handle('probe', () => new TextEncoder().encode('pong'));
    const client = await startClient();
    const long = client.session('vm').exec('sleep 4', { timeoutMs: 20_000 });

    await new Promise((resolve) => setTimeout(resolve, 500));
    const started = Date.now();
    const reply = await client.runtime
      .workspace('shell')
      .request('vm', 'probe', new Uint8Array(), { timeoutMs: 3_000 });
    expect(new TextDecoder().decode(reply.payload)).toBe('pong');
    expect(Date.now() - started).toBeLessThan(3_000);
    await long;
  }, 30_000);

  it('stops serving a key removed by setAuthorizedKeys, and keeps the rest on a bad line', async () => {
    const server = await startServer({ allowControllers: ['laptop', 'phone'] });
    const laptop = (await startClient('laptop')).session('vm');
    const phone = (await startClient('phone')).session('vm');
    expect((await run(laptop, 'echo up')).out).toBe('up\n');
    expect((await run(phone, 'echo up')).out).toBe('up\n');

    const [keepLaptop] = await keyLines(root, ['laptop']);
    expect(() => server.setAuthorizedKeys([keepLaptop!, 'not a key'])).toThrow();
    expect((await run(phone, 'echo still')).out).toBe('still\n');

    server.setAuthorizedKeys([keepLaptop!]);
    const error = await phone
      .exec('touch pwned', { timeoutMs: 10_000 })
      .catch((caught: unknown) => caught);
    expect(DeadDropError.is(error) && error.code).toBe('UNAUTHORIZED');
    await expect(readFile(join(home, 'pwned'))).rejects.toThrow();
    expect((await run(laptop, 'echo kept')).out).toBe('kept\n');
  });

  it('refuses protocol v1 unless allowV1, and says how to fix it', async () => {
    const strict = await startServer();
    const refused = await (
      await startClient('laptop', { v1: true })
    )
      .session('vm')
      .exec('touch pwned', { timeoutMs: 10_000 })
      .catch((caught: unknown) => caught);
    expect(DeadDropError.is(refused) && refused.code).toBe('UNAUTHORIZED');
    expect((refused as Error).message).toMatch(/ddshell keygen/);
    await expect(readFile(join(home, 'pwned'))).rejects.toThrow();

    await strict.stop();
    await startServer({ allowV1: true });
    const old = (await startClient('laptop', { v1: true })).session('vm');
    expect((await run(old, 'echo v1')).out).toBe('v1\n');
  });

  it('refuses a server whose host key changed, and says where the pin is', async () => {
    const first = await startServer();
    const client = await startClient();
    expect((await run(client.session('vm'), 'echo pinned')).out).toBe('pinned\n');
    await first.stop();
    await rm(join(root, 'vm.host_key'));
    await startServer();
    const error = await (
      await startClient()
    )
      .session('vm')
      .exec('touch pwned', { timeoutMs: 10_000 })
      .catch((caught: unknown) => caught);
    expect(DeadDropError.is(error) && error.code).toBe('UNAUTHORIZED');
    expect((error as Error).message).toContain(
      `host key changed. If that was deliberate, remove the vm line from ${join(root, 'laptop.known_hosts')}`,
    );
    await expect(readFile(join(home, 'pwned'))).rejects.toThrow();
  });

  it('with strictHostKeys, talks only to a server pinned beforehand', async () => {
    await startServer();
    const strict = await startClient('laptop', { strictHostKeys: true });
    const error = await strict
      .session('vm')
      .exec('touch pwned', { timeoutMs: 10_000 })
      .catch((caught: unknown) => caught);
    expect(DeadDropError.is(error) && error.code).toBe('UNAUTHORIZED');
    expect((error as Error).message).toMatch(/no host key for vm in .*ddshell hostkey/);
    await expect(readFile(join(home, 'pwned'))).rejects.toThrow();

    const host = await readKeyPair(join(root, 'vm.host_key'));
    await writeFile(join(root, 'laptop.known_hosts'), `vm ${formatPublicKey(host)}\n`);
    const pinned = await startClient('laptop', { strictHostKeys: true });
    expect((await run(pinned.session('vm'), 'echo trusted')).out).toBe('trusted\n');
  });

  it('replays a duplicate completed job without running it again', async () => {
    await startServer();
    const session = (await startClient()).session('vm');
    const jobId = randomUUID();
    const first = await run(session, 'echo ran >> count; wc -l < count', jobId);
    const again = await run(session, 'echo ran >> count; wc -l < count', jobId);
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.out).toBe(first.out);
    expect(await readFile(join(home, 'count'), 'utf8')).toBe('ran\n');
  });

  it('reports a job interrupted by a server crash as unknown and never reruns it', async () => {
    // What a crash leaves behind: `running` persisted, no result.
    const jobId = randomUUID();
    const ledger = new JobLedger<JobResult>(join(root, 'vm-state', 'ddshell-ledger'), 60_000);
    await ledger.open();
    const [line] = await keyLines(root, ['laptop']);
    await ledger.put({
      jobId,
      identity: `key:${parsePublicKey(line!).fingerprint}`,
      sessionId: randomUUID(),
      state: 'running',
      startedAt: Date.now(),
    });

    await startServer();
    const session = (await startClient()).session('vm');
    const response = await session.exec('touch reran', { jobId, timeoutMs: 10_000 });
    expect(response.state).toBe('unknown');
    await expect(readFile(join(home, 'reran'))).rejects.toThrow();
  });

  it('does not let one controller replay another controller’s job', async () => {
    await startServer({ allowControllers: ['laptop', 'desktop'] });
    const jobId = randomUUID();
    await run((await startClient('laptop')).session('vm'), 'echo secret-output', jobId);
    const other = (await startClient('desktop')).session('vm');
    const error = await other
      .exec('true', { jobId, timeoutMs: 10_000 })
      .catch((caught: unknown) => caught);
    expect(DeadDropError.is(error) && error.code).toBe('UNAUTHORIZED');
  });

  it('keeps the workspace secret out of the session environment', async () => {
    process.env.DEADDROP_SECRET = 'not-for-shells';
    cleanup.push(async () => {
      delete process.env.DEADDROP_SECRET;
    });
    await startServer();
    const session = (await startClient()).session('vm');
    expect((await run(session, 'echo "${DEADDROP_SECRET:-absent}"')).out).toBe('absent\n');
  });

  it('closes a one-shot session after its command', async () => {
    const server = await startServer();
    const session = (await startClient()).session('vm');
    const result = completed(await session.exec('echo once', { close: true, timeoutMs: 10_000 }));
    expect(result).toMatchObject({ out: 'once\n', sessionClosed: true });
    expect(server.sessionPids()).toEqual([]);
  });

  it('pings a server without opening a session', async () => {
    const server = await startServer();
    const { result, roundTripMs } = await (await startClient()).ping('vm', { timeoutMs: 10_000 });
    expect(result).toMatchObject({
      version: expect.any(String),
      deadDropVersion: expect.any(String),
    });
    expect(result!.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(roundTripMs).toBeGreaterThanOrEqual(0);
    expect(server.sessionPids()).toEqual([]);
  });

  it('treats a server older than ping as up', async () => {
    // What 0.1.0 answers: its parser wants a session id before it reads the operation.
    const old = new DeadDropRuntime({ config: runtimeConfig('old') });
    await old.start();
    cleanup.push(() => old.stop());
    old.defaultWorkspace().service('shell', {
      v1: () => {
        throw new DeadDropError('BAD_REQUEST', 'sessionId must be a UUID');
      },
    });
    const { result } = await (
      await startClient('laptop', { v1: true })
    ).ping('old', {
      timeoutMs: 10_000,
    });
    expect(result).toBeUndefined();
  });

  it('joins a named session from another client and lists only the caller’s sessions', async () => {
    await startServer({ allowControllers: ['laptop', 'ops'] });
    const first = await startClient();
    await run(first.session('vm', 'build'), 'cd / && export STAGE=one');
    await run(first.session('vm'), 'true');

    // A second process of the same controller finds the session by name alone.
    const again = await startClient();
    const joined = await run(again.session('vm', 'build'), 'pwd; echo "$STAGE"');
    expect(joined.out).toBe('/\none\n');

    // Another controller's session of the same name is its own shell.
    const ops = await startClient('ops');
    const theirs = await run(ops.session('vm', 'build'), 'pwd; echo "${STAGE:-unset}"');
    expect(theirs.out).toBe(`${home}\nunset\n`);

    const { home: listedHome, sessions } = await again.sessions('vm', { timeoutMs: 10_000 });
    expect(listedHome).toBe(home);
    expect(sessions).toHaveLength(2);
    expect(sessions.find((entry) => entry.name === 'build')).toMatchObject({
      sessionId: namedSessionId('build'),
      cwd: '/',
      busy: false,
      pid: expect.any(Number),
    });
    expect(sessions.filter((entry) => entry.name === undefined)).toHaveLength(1);
    const opsView = await ops.sessions('vm', { timeoutMs: 10_000 });
    expect(opsView.sessions.map((entry) => entry.cwd)).toEqual([home]);
  });

  it('derives one stable UUID per session name', () => {
    expect(namedSessionId('build')).toBe(namedSessionId('build'));
    expect(namedSessionId('build')).not.toBe(namedSessionId('build2'));
    expect(isJobId(namedSessionId('build'))).toBe(true);
    expect(namedSessionId('build')).toMatch(/^.{14}8.{3}-[89ab]/);
  });

  it('reports a server without session listing as unsupported', async () => {
    const old = new DeadDropRuntime({ config: runtimeConfig('old') });
    await old.start();
    cleanup.push(() => old.stop());
    old.defaultWorkspace().service('shell', {
      v1: () => {
        throw new DeadDropError('BAD_REQUEST', 'sessionId must be a UUID');
      },
    });
    await expect(
      (await startClient('laptop', { v1: true })).sessions('old', { timeoutMs: 10_000 }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('answers a request queued while the server was down', async () => {
    const client = await startClient();
    const session = client.session('vm');
    const pending = session.exec('echo queued', { timeoutMs: 15_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await startServer();
    const outcome = await pending.then(completed, (error: unknown) => error);
    expect(outcome).toMatchObject({ out: 'queued\n' });
  });
});

describe('streaming output and cancel', () => {
  const collect = () => {
    const seen: Array<{ fd: number; text: string; at: number }> = [];
    return {
      seen,
      onOutput: (fd: 1 | 2, bytes: Buffer) =>
        seen.push({ fd, text: bytes.toString(), at: Date.now() }),
      text: (fd: number) =>
        seen
          .filter((piece) => piece.fd === fd)
          .map((piece) => piece.text)
          .join(''),
    };
  };

  it('streams output while the command runs and ends with its result', async () => {
    await startServer();
    const session = (await startClient()).session('vm');
    const output = collect();
    const started = Date.now();
    const result = completed(
      await session.run('echo one; echo warn >&2; sleep 1.5; echo two', {
        timeoutMs: 10_000,
        onOutput: output.onOutput,
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.out).toBe('');
    expect(output.text(1)).toBe('one\ntwo\n');
    expect(output.text(2)).toBe('warn\n');
    const first = output.seen.find((piece) => piece.text.includes('one'))!;
    expect(first.at - started).toBeLessThan(1200);
  });

  it('answers a re-asked streamed job from the ledger without running it again', async () => {
    await startServer();
    const session = (await startClient()).session('vm');
    const jobId = randomUUID();
    const first = collect();
    await session.run('echo ran >> count; echo out', { jobId, onOutput: first.onOutput });
    const again = collect();
    const replayed = completed(
      await session.run('echo ran >> count', { jobId, onOutput: again.onOutput }),
    );
    expect(replayed.replayed).toBe(true);
    expect(again.text(1)).toBe('out\n');
    expect(await readFile(join(home, 'count'), 'utf8')).toBe('ran\n');
  });

  it('cancels a running command and keeps its session', async () => {
    await startServer();
    const session = (await startClient()).session('vm');
    await run(session, 'cd / && x=kept');
    const jobId = randomUUID();
    const output = collect();
    const running = session.run('echo started; sleep 30; echo after', {
      jobId,
      onOutput: output.onOutput,
    });
    await waitFor(() => output.text(1).includes('started'), 5000);
    expect(await session.cancel(jobId)).toBe(true);
    const result = completed(await running);
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBe(130);
    expect(output.text(1)).toBe('started\n');
    expect(await session.cancel(jobId)).toBe(false);
    expect((await run(session, 'echo "$x"; pwd')).out).toBe('kept\n/\n');
  });

  it('keeps long streamed commands from starving pings', async () => {
    await startServer();
    const client = await startClient('laptop', { maxSessions: 32 });
    const jobs = Array.from({ length: 12 }, () => {
      const session = client.session('vm');
      const jobId = randomUUID();
      return {
        session,
        jobId,
        done: session.run('sleep 30', { jobId, onOutput: () => undefined }),
      };
    });
    await waitFor(() => false, 1500).catch(() => undefined);
    const { result, roundTripMs } = await client.ping('vm', { timeoutMs: 20_000 });
    expect(result).toBeDefined();
    expect(roundTripMs).toBeLessThan(15_000);
    await Promise.all(jobs.map(({ session, jobId }) => session.cancel(jobId)));
    await Promise.all(jobs.map(({ done }) => done));
  }, 60_000);
});

describe('per-controller limits and the audit log', () => {
  it('refuses a session past maxSessions without running the command', async () => {
    await startServer({ maxSessions: 1, allowControllers: ['laptop', 'desktop'] });
    const client = await startClient();
    const first = client.session('vm');
    await run(first, 'true');
    const error = await client
      .session('vm')
      .exec('touch second', { timeoutMs: 10_000 })
      .catch((caught: unknown) => caught);
    expect(DeadDropError.is(error) && error.code).toBe('RATE_LIMITED');
    expect(DeadDropError.is(error) && error.retryable).toBe(false);
    expect((error as Error).message).toMatch(/shell\.maxSessions/);
    await expect(readFile(join(home, 'second'))).rejects.toThrow();

    await first.close();
    expect((await run(client.session('vm'), 'echo ok')).out).toBe('ok\n');
    // Another controller has its own allowance.
    expect((await run((await startClient('desktop')).session('vm'), 'true')).exitCode).toBe(0);
  });

  it('refuses requests past requestsPerMinute and says when to try again', async () => {
    await startServer({ requestsPerMinute: 2 });
    const client = await startClient();
    await client.ping('vm', { timeoutMs: 10_000 });
    await client.ping('vm', { timeoutMs: 10_000 });
    const error = await client.ping('vm', { timeoutMs: 10_000 }).catch((caught: unknown) => caught);
    expect(DeadDropError.is(error) && error.code).toBe('RATE_LIMITED');
    expect((error as Error).message).toMatch(/try again in \d+ s/);
  });

  it('records who ran what kind of thing, never the command or its output', async () => {
    const server = await startServer();
    const session = (await startClient()).session('vm');
    await run(session, 'echo top-secret-output; exit 3');
    await session.close();
    const intruder = (await startClient('mallory')).session('vm');
    await intruder.exec('true', { timeoutMs: 10_000 }).catch(() => undefined);

    await server.stop(); // flushes the log
    const path = join(root, 'vm-state', 'ddshell-audit.log');
    const text = await readFile(path, 'utf8');
    expect(text).not.toMatch(/top-secret|echo/);
    const lines = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line.event)).toEqual([
      'session-open',
      'exec',
      'session-close',
      'refused',
    ]);
    expect(lines[1]).toMatchObject({
      name: 'laptop',
      state: 'completed',
      exitCode: 3,
      bytes: 'top-secret-output\n'.length,
    });
    expect(lines[1]!.controller).toMatch(/^key:SHA256:/);
    expect(lines[3]).toMatchObject({ controller: 'peer:mallory', code: 'UNAUTHORIZED' });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe('job listing', () => {
  it('lists only the caller’s jobs, newest first, and shows a running one', async () => {
    await startServer({ allowControllers: ['laptop', 'ops'] });
    const client = await startClient();
    const session = client.session('vm');
    const failed = randomUUID();
    const worked = randomUUID();
    await run(session, 'exit_code() { return "$1"; }; exit_code 3', failed);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await run(session, 'echo secret-output', worked);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const slow = randomUUID();
    let up = false;
    const running = session.run('echo up; sleep 30', {
      jobId: slow,
      onOutput: () => (up = true),
    });
    await waitFor(() => up, 5000);

    const { now, jobs } = await client.jobs('vm', { timeoutMs: 10_000 });
    expect(jobs.map((job) => job.jobId)).toEqual([slow, worked, failed]);
    expect(jobs[0]).toMatchObject({ state: 'running', sessionId: session.id });
    expect(jobs[0]).not.toHaveProperty('exitCode');
    expect(jobs[1]).toMatchObject({ state: 'completed', exitCode: 0 });
    expect(jobs[2]).toMatchObject({ state: 'completed', exitCode: 3 });
    expect(jobs[2]!.startedAt).toBeLessThanOrEqual(now);
    // No command text and no output, in any field.
    expect(JSON.stringify(jobs)).not.toMatch(/secret-output|exit_code|sleep/);

    const ops = await startClient('ops');
    expect((await ops.jobs('vm', { timeoutMs: 10_000 })).jobs).toEqual([]);
    await session.cancel(slow);
    await running;
  });

  it('shows one job, refuses another controller’s and reports a missing one', async () => {
    await startServer({ allowControllers: ['laptop', 'ops'] });
    const client = await startClient();
    const jobId = randomUUID();
    await run(client.session('vm'), 'true', jobId);

    const { job } = await client.job('vm', jobId, { timeoutMs: 10_000 });
    expect(job).toMatchObject({ jobId, state: 'completed', exitCode: 0, truncated: false });
    const ops = await startClient('ops');
    await expect(ops.job('vm', jobId, { timeoutMs: 10_000 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(client.job('vm', randomUUID(), { timeoutMs: 10_000 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('reports a job left running by a stopped server as unknown', async () => {
    const jobId = randomUUID();
    const ledger = new JobLedger<JobResult>(join(root, 'vm-state', 'ddshell-ledger'), 60_000);
    await ledger.open();
    const [line] = await keyLines(root, ['laptop']);
    await ledger.put({
      jobId,
      identity: `key:${parsePublicKey(line!).fingerprint}`,
      sessionId: randomUUID(),
      state: 'running',
      startedAt: Date.now() - 5000,
    });
    await startServer();
    const { job } = await (await startClient()).job('vm', jobId, { timeoutMs: 10_000 });
    expect(job.state).toBe('unknown');
    expect(job.finishedAt).toBeGreaterThan(job.startedAt);
  });

  it('reports a server without job listing as unsupported', async () => {
    const old = new DeadDropRuntime({ config: runtimeConfig('old') });
    await old.start();
    cleanup.push(() => old.stop());
    old.defaultWorkspace().service('shell', {
      v1: () => {
        throw new DeadDropError('BAD_REQUEST', 'sessionId must be a UUID');
      },
    });
    const client = await startClient('laptop', { v1: true });
    await expect(client.jobs('old', { timeoutMs: 10_000 })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    await expect(client.job('old', randomUUID(), { timeoutMs: 10_000 })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
  });
});

describe.skipIf(!ptyInstalled)('terminal', () => {
  /** A caller's view of one terminal: what it typed, and the screen so far. */
  function terminal(client: ShellClient, ttyId = randomUUID()) {
    const call = <Result>(request: ShellRequest) =>
      client.call<Result>('vm', request, { timeoutMs: 10_000 });
    let sent = 0;
    let offset = 0;
    let screen = '';
    const io = async (fields: { input?: string; cols?: number; rows?: number } = {}) => {
      const request: ShellRequest = {
        v: 1,
        op: 'tty-io',
        ttyId,
        inputOffset: sent,
        offset,
        waitMs: 200,
        ...fields,
      };
      const answer = await call<TtyOutput | TtyLost>(request);
      if (answer.state === 'session_lost') return answer;
      offset = answer.next;
      for (const { data } of answer.frames) screen += Buffer.from(data, 'base64').toString();
      return answer;
    };
    return {
      ttyId,
      call,
      open: (cols = 100, rows = 30) => call<TtyOpened>({ v: 1, op: 'tty-open', ttyId, cols, rows }),
      io,
      screen: () => screen,
      /**
       * Types `text`, delivering the same request `deliveries` times as a
       * retry would, then reads until `until` shows on the screen.
       */
      async type(
        text: string,
        until: RegExp,
        fields: { cols?: number; rows?: number; deliveries?: number } = {},
      ) {
        const { deliveries = 1, ...size } = fields;
        const input = Buffer.from(text).toString('base64');
        for (let delivery = 0; delivery < deliveries; delivery++) await io({ input, ...size });
        sent += Buffer.byteLength(text);
        await waitForScreen(until);
      },
    };
    async function waitForScreen(until: RegExp) {
      const deadline = Date.now() + 10_000;
      while (!until.test(screen)) {
        if (Date.now() > deadline) throw new Error(`never saw ${String(until)} in ${screen}`);
        await io();
      }
    }
  }

  it('runs a shell on a pty, types each byte once, resizes, and reports the exit', async () => {
    await startServer();
    const tty = terminal(await startClient());
    await tty.open(100, 30);
    await tty.type('stty size\n', /30 100/);

    // The same request delivered twice must not type twice.
    await tty.type('echo $((20+22))\n', /^42\r?$/m, { deliveries: 2 });
    await tty.io();
    expect(tty.screen().match(/^42\r?$/gm)).toHaveLength(1);

    await expect(
      tty.call({
        v: 1,
        op: 'tty-io',
        ttyId: tty.ttyId,
        input: Buffer.from('x').toString('base64'),
        inputOffset: 9999,
        offset: 0,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await tty.type('stty size\n', /10 50/, { cols: 50, rows: 10 });
    await tty.type('exit 3\n', /exit 3/);
    let last = await tty.io();
    for (let tries = 0; last.state === 'running' && tries < 50; tries++) last = await tty.io();
    expect(last).toMatchObject({ state: 'exited', exit: { exitCode: 3 } });
  });

  it('keeps terminals to their owner and counts them toward maxSessions', async () => {
    await startServer({ allowControllers: ['laptop', 'ops'], maxSessions: 1 });
    const mine = terminal(await startClient());
    await mine.open();
    await mine.open();
    await expect(terminal(await startClient()).open()).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });

    const theirs = terminal(await startClient('ops'), mine.ttyId);
    expect(await theirs.io()).toMatchObject({ state: 'session_lost' });
    expect(await mine.io()).toMatchObject({ state: 'running' });

    expect(await mine.call({ v: 1, op: 'tty-close', ttyId: mine.ttyId })).toEqual({ closed: true });
    expect(await mine.io()).toMatchObject({ state: 'session_lost' });
    expect(await mine.call({ v: 1, op: 'tty-close', ttyId: mine.ttyId })).toEqual({
      closed: false,
    });
  });

  it('closes an idle terminal and kills its shell', async () => {
    const server = await startServer({ idleTimeoutMs: 200 });
    const tty = terminal(await startClient());
    await tty.open();
    await tty.type('echo $$\n', /^\d+\r?$/m);
    const pid = Number(/^(\d+)\r?$/m.exec(tty.screen())![1]);
    expect(isAlive(pid)).toBe(true);

    await waitFor(() => !isAlive(pid), 5000);
    expect(await tty.io()).toMatchObject({ state: 'session_lost' });
    await server.stop();
  });

  it('reports a server without terminal mode as unsupported', async () => {
    const old = new DeadDropRuntime({ config: runtimeConfig('old') });
    await old.start();
    cleanup.push(() => old.stop());
    old.defaultWorkspace().service('shell', {
      v1: () => {
        throw new DeadDropError('BAD_REQUEST', 'sessionId must be a UUID');
      },
    });
    const client = await startClient('laptop', { v1: true });
    await expect(
      client.tty('old', { cols: 80, rows: 24 }, { timeoutMs: 10_000 }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('logs opening and closing a terminal, never what was typed or shown', async () => {
    const server = await startServer();
    const tty = terminal(await startClient());
    await tty.open();
    await tty.type('echo top-secret-keys\n', /^top-secret-keys\r?$/m);
    await tty.call({ v: 1, op: 'tty-close', ttyId: tty.ttyId });

    await server.stop();
    const text = await readFile(join(root, 'vm-state', 'ddshell-audit.log'), 'utf8');
    expect(text).not.toMatch(/top-secret|echo/);
    expect(
      text
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { event: string }).event),
    ).toEqual(['tty-open', 'tty-close']);
  });
});

describe('port forwarding', () => {
  /** A local TCP service: echoes what it gets, and counts connections and the bytes it saw. */
  async function service() {
    const sockets: Socket[] = [];
    let connections = 0;
    let seen = '';
    const server: Server = createServer((socket) => {
      connections += 1;
      sockets.push(socket);
      socket.on('data', (data) => {
        seen += data.toString();
        socket.write(data);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        }),
    );
    const { port } = server.address() as { port: number };
    return {
      port,
      target: `127.0.0.1:${port}`,
      connections: () => connections,
      seen: () => seen,
      hangUp: () => sockets.forEach((socket) => socket.end()),
    };
  }

  function forward(client: ShellClient, port: number, streamId = randomUUID()) {
    const call = <Result>(request: ShellRequest) =>
      client.call<Result>('vm', request, { timeoutMs: 10_000 });
    let offset = 0;
    let got = '';
    return {
      streamId,
      call,
      open: () => call<TcpOpened>({ v: 1, op: 'tcp-open', streamId, host: '127.0.0.1', port }),
      io: async (input?: string, inputOffset = 0) => {
        const answer = await call<TcpOutput | TcpLost>({
          v: 1,
          op: 'tcp-io',
          streamId,
          inputOffset,
          offset,
          waitMs: 200,
          ...(input === undefined ? {} : { input: Buffer.from(input).toString('base64') }),
        });
        if (answer.state === 'session_lost') return answer;
        offset = answer.next;
        for (const { data } of answer.frames) got += Buffer.from(data, 'base64').toString();
        return answer;
      },
      got: () => got,
    };
  }

  it('relays bytes to an allowed host once each, and closes the connection', async () => {
    const echo = await service();
    await startServer({ allowForwards: [echo.target] });
    const stream = forward(await startClient(), echo.port);
    await stream.open();
    await stream.open();
    expect(echo.connections()).toBe(1);

    // The same request delivered twice must not send twice.
    await stream.io('hello', 0);
    await stream.io('hello', 0);
    for (let tries = 0; tries < 20 && stream.got() !== 'hello'; tries++) await stream.io();
    expect(stream.got()).toBe('hello');
    expect(echo.seen()).toBe('hello');

    await expect(stream.io('x', 99)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await stream.call({ v: 1, op: 'tcp-close', streamId: stream.streamId })).toEqual({
      closed: true,
    });
    expect(await stream.io()).toMatchObject({ state: 'session_lost' });
  });

  it('refuses hosts that are not allowed before connecting, and reports a refused connection', async () => {
    const hidden = await service();
    const open = await service();
    await startServer({ allowForwards: [open.target, '127.0.0.1:9'] });
    const client = await startClient();

    await expect(forward(client, hidden.port).open()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(hidden.connections()).toBe(0);
    await expect(forward(client, 9).open()).rejects.toMatchObject({ code: 'SERVICE_ERROR' });
  });

  it('tells the client when the far end hangs up, and counts toward maxSessions', async () => {
    const echo = await service();
    await startServer({ allowForwards: [echo.target], maxSessions: 1 });
    const client = await startClient();
    const stream = forward(client, echo.port);
    await stream.open();
    await expect(forward(client, echo.port).open()).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });

    echo.hangUp();
    let last = await stream.io();
    for (let tries = 0; last.state === 'open' && tries < 50; tries++) last = await stream.io();
    expect(last).toMatchObject({ state: 'closed' });
  });

  it('logs opening and closing, never the bytes', async () => {
    const echo = await service();
    const server = await startServer({ allowForwards: [echo.target] });
    const stream = forward(await startClient(), echo.port);
    await stream.open();
    await stream.io('top-secret-bytes', 0);
    await stream.call({ v: 1, op: 'tcp-close', streamId: stream.streamId });

    await server.stop();
    const text = await readFile(join(root, 'vm-state', 'ddshell-audit.log'), 'utf8');
    expect(text).not.toMatch(/top-secret/);
    const lines = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line.event)).toEqual(['forward-open', 'forward-close']);
    expect(lines[0]).toMatchObject({ target: echo.target });
  });
});
