import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
import { isJobId, namedSessionId, type ExecResponse, type JobResult } from '../src/protocol.js';
import { isAlive, keyLines, waitFor } from './helpers.js';

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
