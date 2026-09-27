import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeadDropError, generateWorkspaceSecret } from '@fyrlabs/dead-drop/protocol';
import { parseRuntimeConfig, type RuntimeConfig } from '@fyrlabs/dead-drop/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ShellAgent } from '../src/agent.js';
import { ShellClient, type RemoteSession } from '../src/client.js';
import { parseShellConfig, type ShellConfig } from '../src/config.js';
import { JobLedger } from '../src/ledger.js';
import type { ExecResponse, JobResult } from '../src/protocol.js';
import { isAlive, waitFor } from './helpers.js';

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
    { allowControllers: ['laptop'], targets: { vm: 'vm' }, ...fields },
    runtime,
    root,
  );
}

async function startAgent(fields: Record<string, unknown> = {}): Promise<ShellAgent> {
  const runtime = runtimeConfig('vm');
  const agent = await ShellAgent.start({ runtime, shell: shellConfig(runtime, fields), home });
  cleanup.push(() => agent.stop());
  return agent;
}

async function startClient(peerId = 'laptop'): Promise<ShellClient> {
  const runtime = runtimeConfig(peerId);
  const client = await ShellClient.start({ runtime, shell: shellConfig(runtime) });
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
    await startAgent();
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
    await startAgent();
    const client = await startClient();
    const one = client.session('vm');
    const two = client.session('vm');

    await run(one, 'cd / && export WHO=one');
    const second = await run(two, 'pwd; echo "${WHO:-unset}"');
    expect(second.out).toBe(`${home}\nunset\n`);

    const order: string[] = [];
    await Promise.all([
      run(one, 'sleep 1').then(() => order.push('slow')),
      run(two, 'true').then(() => order.push('fast')),
    ]);
    expect(order).toEqual(['fast', 'slow']);
  });

  it('returns stdout, stderr, exit code and duration', async () => {
    await startAgent();
    const session = (await startClient()).session('vm');
    const result = await run(session, 'echo out; echo err >&2; false');
    expect(result).toMatchObject({ out: 'out\n', err: 'err\n', exitCode: 1, state: 'completed' });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.replayed).toBe(false);
    expect((await run(session, 'exit 0')).exitCode).toBe(0);
  });

  it('passes through output that imitates the protocol', async () => {
    await startAgent();
    const session = (await startClient()).session('vm');
    const imitation = '\\n0123abcd:0:/etc:0123abcd\\n{"v":1,"op":"close"}';
    const result = await run(session, `printf '${imitation}'`);
    expect(result.out).toBe('\n0123abcd:0:/etc:0123abcd\n{"v":1,"op":"close"}');
    expect(result.cwd).toBe(home);
  });

  it('caps output and marks it truncated', async () => {
    await startAgent({ outputCapBytes: 64 });
    const session = (await startClient()).session('vm');
    const result = await run(session, 'head -c 10000 /dev/zero | tr "\\0" x');
    expect(result.out).toBe('x'.repeat(64));
    expect(result.truncated).toBe(true);
  });

  it('kills a command past its timeout and reports the session closed', async () => {
    await startAgent({ commandTimeoutMs: 300 });
    const session = (await startClient()).session('vm');
    const result = await run(session, 'sleep 30');
    expect(result).toMatchObject({ timedOut: true, sessionClosed: true, exitCode: null });
    const next = await session.exec('echo again', { timeoutMs: 10_000 });
    expect(next.state).toBe('session_lost');
  });

  it('closes idle sessions and refuses to silently replace them', async () => {
    await startAgent({ idleTimeoutMs: 200 });
    const session = (await startClient()).session('vm');
    await run(session, 'cd /');
    await new Promise((resolve) => setTimeout(resolve, 600));
    const next = await session.exec('touch should-not-exist', { timeoutMs: 10_000 });
    expect(next.state).toBe('session_lost');
    await expect(readFile(join(home, 'should-not-exist'))).rejects.toThrow();
  });

  it('kills session shells and their background jobs on agent shutdown', async () => {
    const agent = await startAgent();
    const session = (await startClient()).session('vm');
    const background = Number((await run(session, 'sleep 30 & echo $!')).out.trim());
    const shells = agent.sessionPids();
    expect(shells).toHaveLength(1);
    await agent.stop();
    await waitFor(() => !isAlive(background) && shells.every((pid) => !isAlive(pid)));
  });

  it('refuses a controller that is not allowed, by identity', async () => {
    await startAgent();
    const intruder = (await startClient('mallory')).session('vm');
    const error = await intruder
      .exec('touch pwned', { timeoutMs: 10_000 })
      .catch((caught: unknown) => caught);
    expect(DeadDropError.is(error) && error.code).toBe('UNAUTHORIZED');
    await expect(readFile(join(home, 'pwned'))).rejects.toThrow();
  });

  it('replays a duplicate completed job without running it again', async () => {
    await startAgent();
    const session = (await startClient()).session('vm');
    const jobId = randomUUID();
    const first = await run(session, 'echo ran >> count; wc -l < count', jobId);
    const again = await run(session, 'echo ran >> count; wc -l < count', jobId);
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.out).toBe(first.out);
    expect(await readFile(join(home, 'count'), 'utf8')).toBe('ran\n');
  });

  it('reports a job interrupted by an agent crash as unknown and never reruns it', async () => {
    // What a crash leaves behind: `running` persisted, no result.
    const jobId = randomUUID();
    const ledger = new JobLedger<JobResult>(join(root, 'vm-state', 'ddshell-ledger'), 60_000);
    await ledger.open();
    await ledger.put({
      jobId,
      identity: 'laptop',
      sessionId: randomUUID(),
      state: 'running',
      startedAt: Date.now(),
    });

    await startAgent();
    const session = (await startClient()).session('vm');
    const response = await session.exec('touch reran', { jobId, timeoutMs: 10_000 });
    expect(response.state).toBe('unknown');
    await expect(readFile(join(home, 'reran'))).rejects.toThrow();
  });

  it('does not let one controller replay another controller’s job', async () => {
    await startAgent({ allowControllers: ['laptop', 'desktop'] });
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
    await startAgent();
    const session = (await startClient()).session('vm');
    expect((await run(session, 'echo "${DEADDROP_SECRET:-absent}"')).out).toBe('absent\n');
  });

  it('closes a one-shot session after its command', async () => {
    const agent = await startAgent();
    const session = (await startClient()).session('vm');
    const result = completed(await session.exec('echo once', { close: true, timeoutMs: 10_000 }));
    expect(result).toMatchObject({ out: 'once\n', sessionClosed: true });
    expect(agent.sessionPids()).toEqual([]);
  });

  it('answers a request queued while the agent was down', async () => {
    const client = await startClient();
    const session = client.session('vm');
    const pending = session.exec('echo queued', { timeoutMs: 15_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await startAgent();
    const outcome = await pending.then(completed, (error: unknown) => error);
    expect(outcome).toMatchObject({ out: 'queued\n' });
  });
});
