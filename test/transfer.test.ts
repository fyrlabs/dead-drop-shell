import { execFileSync } from 'node:child_process';
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
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeadDropError, generateWorkspaceSecret } from '@fyrlabs/dead-drop/protocol';
import { parseRuntimeConfig, type RuntimeConfig } from '@fyrlabs/dead-drop/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ShellClient } from '../src/client.js';
import { parseShellConfig } from '../src/config.js';
import { type ShellRequest, type TransferOpened } from '../src/protocol.js';
import { ShellServer } from '../src/server.js';
import { keyLines, waitFor } from './helpers.js';

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
  const authorizedKeys = await keyLines(root, ['laptop']);
  const shell = (runtime: RuntimeConfig) =>
    parseShellConfig(
      { authorizedKeys, key: join(root, 'laptop.key'), transferChunkBytes: 1000, ...fields },
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

/** One transfer step by hand, signed like any other request. */
const raw = <T>(client: ShellClient, request: Record<string, unknown>) =>
  client.call<T>('vm', { v: 1, ...request } as unknown as ShellRequest, { timeoutMs: 10_000 });

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
    const call = <T>(request: Record<string, unknown>) => raw<T>(client, request);
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
    await raw(client, {
      op: 'put-open',
      transferId,
      path: 'left',
      name: 'left',
      size: 1,
      sha256: sha256(Buffer.from('x')),
      mode: 0o600,
    });
    expect(await temporaries(home)).toHaveLength(1);
    await waitFor(() => !existsSync(join(home, `.left.ddshell-${transferId}.tmp`)));
    const error = await raw(client, { op: 'put-commit', transferId }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('copies a directory tree both ways, following links and skipping what it cannot copy', async () => {
    const client = await start();
    const tree = join(local, 'tree');
    const big = randomBytes(5_000);
    await mkdir(join(tree, 'sub', 'deeper'), { recursive: true });
    await mkdir(join(tree, 'empty'));
    await writeFile(join(tree, 'small.txt'), 'small');
    await writeFile(join(tree, 'sub', 'big.bin'), big);
    await writeFile(join(tree, 'sub', 'deeper', 'nothing'), '');
    await chmod(join(tree, 'small.txt'), 0o640);
    await symlink('small.txt', join(tree, 'link.txt'));
    await symlink('..', join(tree, 'sub', 'loop'));
    await symlink('missing', join(tree, 'dangling'));
    execFileSync('mkfifo', [join(tree, 'fifo')]);

    const put = await client.putTree('vm', tree, 'copy', { timeoutMs: 10_000 });
    expect(put).toMatchObject({ path: join(home, 'copy'), files: 4, bytes: 5_010, failed: [] });
    expect(put.skipped.map((entry) => entry.path).sort()).toEqual(['dangling', 'fifo', 'sub/loop']);
    expect(await readFile(join(home, 'copy', 'sub', 'big.bin'))).toEqual(big);
    expect(await readFile(join(home, 'copy', 'link.txt'), 'utf8')).toBe('small');
    expect((await stat(join(home, 'copy', 'small.txt'))).mode & 0o777).toBe(0o640);
    expect((await stat(join(home, 'copy', 'empty'))).isDirectory()).toBe(true);
    expect(await readFile(join(home, 'copy', 'sub', 'deeper', 'nothing'), 'utf8')).toBe('');

    // Into an existing directory it lands under its own name, as scp -r does.
    const again = await client.putTree('vm', tree, 'copy', { timeoutMs: 10_000 });
    expect(again.path).toBe(join(home, 'copy', 'tree'));

    const progress: number[] = [];
    const got = await client.getTree('vm', 'copy/', join(local, 'back'), {
      timeoutMs: 10_000,
      onProgress: (done) => progress.push(done),
    });
    expect(got).toMatchObject({ path: join(local, 'back'), files: 8, failed: [], skipped: [] });
    expect(await readFile(join(local, 'back', 'sub', 'big.bin'))).toEqual(big);
    expect(await readFile(join(local, 'back', 'tree', 'link.txt'), 'utf8')).toBe('small');
    expect((await stat(join(local, 'back', 'empty'))).isDirectory()).toBe(true);
    expect(Math.max(...progress)).toBe(2 * 5_010);
    expect(await temporaries(join(local, 'back'))).toEqual([]);
  });

  it('copies a single file when asked for a tree', async () => {
    const client = await start();
    await writeFile(join(local, 'one'), 'one');
    expect(await client.putTree('vm', join(local, 'one'), 'one', { timeoutMs: 10_000 })).toEqual({
      path: join(home, 'one'),
      files: 1,
      bytes: 3,
      failed: [],
      skipped: [],
    });
    const got = await client.getTree('vm', 'one', join(local, 'two'), { timeoutMs: 10_000 });
    expect(got.path).toBe(join(local, 'two'));
    expect(await readFile(join(local, 'two'), 'utf8')).toBe('one');
  });

  it('moves a file that fits one chunk in a single request each way', async () => {
    const client = await start();
    const call = <T>(request: Record<string, unknown>) => raw<T>(client, request);
    const data = Buffer.from('inline');
    const put = await call<TransferOpened>({
      op: 'put-open',
      transferId: randomUUID(),
      path: 'inline',
      name: 'inline',
      size: data.length,
      sha256: sha256(data),
      mode: 0o600,
      data: data.toString('base64'),
    });
    expect(put.committed).toBe(true);
    expect(await readFile(join(home, 'inline'), 'utf8')).toBe('inline');

    const get = await call<TransferOpened>({
      op: 'get-open',
      transferId: randomUUID(),
      path: 'inline',
      inline: 1_000,
    });
    expect(Buffer.from(get.data!, 'base64').toString()).toBe('inline');
    expect(await temporaries(home)).toEqual([]);
  });

  it('refuses a directory path that climbs out of the copy', async () => {
    const client = await start();
    const error = await raw(client, {
      op: 'mkdir',
      path: 'x',
      name: 'x',
      mode: 0o755,
      dirs: [{ path: '../y', mode: 0o755 }],
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect(existsSync(join(home, 'x'))).toBe(false);
  });
});
