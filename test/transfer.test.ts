import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeadDropError, generateWorkspaceSecret } from '@fyrlabs/dead-drop/protocol';
import { parseRuntimeConfig, type RuntimeConfig } from '@fyrlabs/dead-drop/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ShellClient } from '../src/client.js';
import { parseShellConfig } from '../src/config.js';
import { SHELL_CHANNEL, type TransferOpened } from '../src/protocol.js';
import { ShellServer } from '../src/server.js';
import { waitFor } from './helpers.js';

let root: string;
let home: string;
let local: string;
let secret: string;
const cleanup: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ddshell-xfer-')));
  home = join(root, 'home');
  local = join(root, 'local');
  await mkdir(home);
  await mkdir(local);
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

async function start(fields: Record<string, unknown> = {}): Promise<ShellClient> {
  const serverRuntime = runtimeConfig('vm');
  const shell = (runtime: RuntimeConfig) =>
    parseShellConfig(
      { allowControllers: ['laptop'], transferChunkBytes: 1000, ...fields },
      runtime,
      root,
    );
  const server = await ShellServer.start({
    runtime: serverRuntime,
    shell: shell(serverRuntime),
    home,
  });
  cleanup.push(() => server.stop());
  const clientRuntime = runtimeConfig('laptop');
  const client = await ShellClient.start({ runtime: clientRuntime, shell: shell(clientRuntime) });
  cleanup.push(() => client.stop());
  return client;
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const temporaries = async (directory: string) =>
  (await readdir(directory)).filter((name) => name.endsWith('.tmp'));

describe('file transfer', () => {
  it('puts and gets a file in many chunks, keeping bytes, hash and mode', async () => {
    const client = await start();
    const data = randomBytes(10_500);
    await writeFile(join(local, 'blob.bin'), data);
    await chmod(join(local, 'blob.bin'), 0o640);
    const progress: number[] = [];

    const put = await client.put('vm', join(local, 'blob.bin'), 'blob.bin', {
      timeoutMs: 10_000,
      onProgress: (done) => progress.push(done),
    });
    expect(put).toMatchObject({ path: join(home, 'blob.bin'), size: 10_500, sha256: sha256(data) });
    expect(await readFile(join(home, 'blob.bin'))).toEqual(data);
    expect((await stat(join(home, 'blob.bin'))).mode & 0o777).toBe(0o640);
    expect(progress).toHaveLength(11);
    expect(Math.max(...progress)).toBe(10_500);

    const got = await client.get('vm', '~/blob.bin', join(local, 'back.bin'), {
      timeoutMs: 10_000,
    });
    expect(got).toMatchObject({ path: join(local, 'back.bin'), sha256: sha256(data) });
    expect(await readFile(join(local, 'back.bin'))).toEqual(data);
    expect((await stat(join(local, 'back.bin'))).mode & 0o777).toBe(0o640);
    expect(await temporaries(home)).toEqual([]);
    expect(await temporaries(local)).toEqual([]);
  });

  it('copies an empty file and lands inside an existing directory under the source name', async () => {
    const client = await start();
    await mkdir(join(home, 'inbox'));
    await writeFile(join(local, 'empty'), '');
    const put = await client.put('vm', join(local, 'empty'), 'inbox', { timeoutMs: 10_000 });
    expect(put.path).toBe(join(home, 'inbox', 'empty'));
    expect(await readFile(join(home, 'inbox', 'empty'), 'utf8')).toBe('');

    await rm(join(local, 'empty'));
    const got = await client.get('vm', 'inbox/empty', `${local}/`, { timeoutMs: 10_000 });
    expect(got.path).toBe(join(local, 'empty'));
  });

  it('replaces an existing file atomically', async () => {
    const client = await start();
    await writeFile(join(home, 'config'), 'old');
    await writeFile(join(local, 'config'), 'new');
    await client.put('vm', join(local, 'config'), join(home, 'config'), { timeoutMs: 10_000 });
    expect(await readFile(join(home, 'config'), 'utf8')).toBe('new');
  });

  it('refuses files over the cap in both directions and leaves nothing behind', async () => {
    const client = await start({ transferCapBytes: 100 });
    await writeFile(join(local, 'big'), randomBytes(101));
    await writeFile(join(home, 'big'), randomBytes(101));

    const put = await client
      .put('vm', join(local, 'big'), 'big-copy', { timeoutMs: 10_000 })
      .catch((e: unknown) => e);
    expect(put).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    const get = await client
      .get('vm', 'big', join(local, 'got'), { timeoutMs: 10_000 })
      .catch((e: unknown) => e);
    expect(get).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(existsSync(join(home, 'big-copy'))).toBe(false);
    expect(existsSync(join(local, 'got'))).toBe(false);
    expect(await temporaries(home)).toEqual([]);
  });

  it('reports a missing file, a directory, and a missing destination directory', async () => {
    const client = await start();
    await mkdir(join(home, 'dir'));
    await writeFile(join(local, 'file'), 'x');
    const failure = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);

    expect(await failure(client.get('vm', 'nope', local, { timeoutMs: 10_000 }))).toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await failure(client.get('vm', 'dir', local, { timeoutMs: 10_000 }))).toMatchObject({
      message: expect.stringMatching(/is a directory/),
    });
    expect(
      await failure(client.put('vm', join(local, 'file'), 'missing/', { timeoutMs: 10_000 })),
    ).toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await failure(client.put('vm', local, 'x', { timeoutMs: 10_000 }))).toMatchObject({
      message: expect.stringMatching(/not a regular file/),
    });
  });

  it('refuses a commit whose bytes do not match, answers duplicates alike, and keeps the old file', async () => {
    const client = await start();
    await writeFile(join(home, 'target'), 'original');
    const call = <T>(request: Record<string, unknown>) =>
      client.workspace.call<T>('vm', SHELL_CHANNEL, { v: 1, ...request }, { timeoutMs: 10_000 });
    const transferId = randomUUID();
    const open = {
      op: 'put-open',
      transferId,
      path: 'target',
      name: 'target',
      size: 5,
      sha256: sha256(Buffer.from('hello')),
      mode: 0o600,
    };
    const first = await call<TransferOpened>(open);
    expect(await call<TransferOpened>(open)).toEqual(first);
    await call({
      op: 'put-chunk',
      transferId,
      offset: 0,
      data: Buffer.from('HELLO').toString('base64'),
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await call({ op: 'put-commit', transferId }).catch((e: unknown) => e);
      expect(DeadDropError.is(error) && error.message).toMatch(/expected 5 bytes/);
    }
    expect(await readFile(join(home, 'target'), 'utf8')).toBe('original');
    expect(await temporaries(home)).toEqual([]);
  });

  it('drops an abandoned upload and its temporary file after the idle timeout', async () => {
    const client = await start({ idleTimeoutMs: 100 });
    const transferId = randomUUID();
    await client.workspace.call(
      'vm',
      SHELL_CHANNEL,
      {
        v: 1,
        op: 'put-open',
        transferId,
        path: 'left',
        name: 'left',
        size: 1,
        sha256: sha256(Buffer.from('x')),
        mode: 0o600,
      },
      { timeoutMs: 10_000 },
    );
    expect(await temporaries(home)).toHaveLength(1);
    await waitFor(() => !existsSync(join(home, `.left.ddshell-${transferId}.tmp`)));
    const error = await client.workspace
      .call('vm', SHELL_CHANNEL, { v: 1, op: 'put-commit', transferId }, { timeoutMs: 10_000 })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'NOT_FOUND' });
  });
});
