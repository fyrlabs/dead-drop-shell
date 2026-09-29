import { createHash } from 'node:crypto';
import {
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { DeadDropError } from '@fyrlabs/dead-drop/protocol';

import type {
  GetChunkRequest,
  GetChunkResult,
  GetOpenRequest,
  ListResult,
  MkdirRequest,
  MkdirResult,
  PutChunkRequest,
  PutChunkResult,
  PutOpenRequest,
  TransferCloseResult,
  TransferOpened,
  TreeEntry,
} from './protocol.js';
import { MAX_TREE_ENTRIES } from './protocol.js';

/** Hashes a file from its start, whatever the handle's position, and reports its length. */
export async function hashFile(handle: FileHandle): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  let size = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    size += bytesRead;
  }
  return { size, sha256: hash.digest('hex') };
}

/**
 * Where a copy named `name` lands when sent to `path`, as with cp and scp: inside
 * `path` if it is a directory, through the link if it is a symlink, else `path`.
 * A file refuses to land on a directory; a directory merges into one.
 */
export async function destination(
  path: string,
  name: string,
  kind: 'file' | 'dir' = 'file',
): Promise<string> {
  const inside = await isDirectory(path);
  if (!inside && path.endsWith('/')) fail('NOT_FOUND', `no such directory: ${path}`);
  const target = inside ? join(path, name) : path;
  if (kind === 'file' && (await isDirectory(target)))
    fail('SERVICE_ERROR', `${target} is a directory`);
  try {
    return await realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return target;
    throw fsError(error, target);
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw fsError(error, path);
  }
}

/**
 * Creates a directory, keeping one that exists. Owner access is added while the
 * copy fills it, as scp does, so a read-only source directory can still be filled.
 */
export async function makeDirectory(path: string, mode: number): Promise<void> {
  try {
    await mkdir(path, { mode: mode | 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw fsError(error, path);
    if (!(await isDirectory(path))) fail('SERVICE_ERROR', `${path} exists and is not a directory`);
  }
}

/** Creates `root` and `dirs` below it, parents first, as `mkdir -p` would. */
export async function makeTree(
  root: string,
  mode: number,
  dirs: ReadonlyArray<{ path: string; mode: number }>,
): Promise<void> {
  await makeDirectory(root, mode);
  for (const dir of dirs) await makeDirectory(join(root, dir.path), dir.mode);
}

/**
 * Lists `path` for a recursive copy. Symlinks are followed, as scp -r does,
 * except into a directory that is already one of their own parents.
 */
export async function walk(path: string): Promise<Omit<ListResult, 'path'>> {
  const top = await stat(path).catch((error: unknown) => {
    throw fsError(error, path);
  });
  const root = { kind: top.isDirectory() ? 'dir' : 'file', mode: top.mode & 0o777 } as const;
  if (!top.isDirectory()) {
    if (!top.isFile()) fail('SERVICE_ERROR', `${path} is not a regular file or directory`);
    return { ...root, size: top.size, entries: [], skipped: [] };
  }
  const entries: TreeEntry[] = [];
  const skipped: ListResult['skipped'] = [];
  const visit = async (directory: string, prefix: string, parents: string[]) => {
    let names: string[];
    try {
      names = (await readdir(directory)).sort();
    } catch (error) {
      if (prefix === '') throw fsError(error, directory);
      skipped.push({ path: prefix, reason: fsError(error, directory).message });
      return;
    }
    for (const name of names) {
      const relative = prefix === '' ? name : `${prefix}/${name}`;
      const full = join(directory, name);
      const stats = await stat(full).catch(() => undefined);
      if (!stats) {
        skipped.push({ path: relative, reason: 'broken symbolic link or vanished' });
        continue;
      }
      if (stats.isDirectory()) {
        const id = `${stats.dev}:${stats.ino}`;
        if (parents.includes(id)) {
          skipped.push({ path: relative, reason: 'symbolic link loop' });
          continue;
        }
        add({ path: relative, kind: 'dir', mode: stats.mode & 0o777, size: 0 });
        await visit(full, relative, [...parents, id]);
      } else if (stats.isFile()) {
        add({ path: relative, kind: 'file', mode: stats.mode & 0o777, size: stats.size });
      } else {
        skipped.push({ path: relative, reason: 'not a regular file or directory' });
      }
    }
  };
  const add = (entry: TreeEntry) => {
    if (entries.length >= MAX_TREE_ENTRIES) {
      fail('PAYLOAD_TOO_LARGE', `${path} holds more than ${MAX_TREE_ENTRIES} entries`);
    }
    entries.push(entry);
  };
  await visit(path, '', [`${top.dev}:${top.ino}`]);
  return { ...root, size: 0, entries, skipped };
}

/** A hidden file beside the target, so the final rename never crosses file systems. */
export function temporaryPath(target: string, transferId: string): string {
  return join(dirname(target), `.${basename(target)}.ddshell-${transferId}.tmp`);
}

function fail(
  code: 'NOT_FOUND' | 'SERVICE_ERROR' | 'PAYLOAD_TOO_LARGE' | 'BAD_REQUEST',
  message: string,
): never {
  throw new DeadDropError(code, message);
}

/**
 * A handler that throws a plain error is answered `INTERNAL`, which clients
 * retry. A missing file or a permission error will not fix itself.
 */
export function fsError(error: unknown, path: string): DeadDropError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new DeadDropError('NOT_FOUND', `no such file or directory: ${path}`);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new DeadDropError('SERVICE_ERROR', `permission denied: ${path}`);
  }
  if (code === 'EISDIR') return new DeadDropError('SERVICE_ERROR', `${path} is a directory`);
  return new DeadDropError('SERVICE_ERROR', `${code ?? 'error'}: ${path}: ${String(error)}`);
}

export interface TransferLimits {
  /** Largest file accepted or sent. */
  capBytes: number;
  chunkBytes: number;
  /** A transfer with no request for this long is dropped. */
  idleMs: number;
}

interface Upload {
  kind: 'put';
  handle: FileHandle;
  temporary: string;
  opened: TransferOpened;
  lastUsed: number;
  closed: boolean;
  commit?: Promise<TransferOpened>;
}

interface Download {
  kind: 'get';
  handle: FileHandle;
  opened: TransferOpened;
  lastUsed: number;
  closed: boolean;
}

type Transfer = Upload | Download;

/**
 * Server side of file transfer. Every operation is idempotent, so a duplicate
 * delivery or a client retry is harmless and no ledger is needed: an open with
 * a known id returns the first answer, a chunk rewrites the same bytes at the
 * same offset, and a commit returns the first commit's outcome.
 *
 * Transfers live in memory. After a server restart, a transfer's next request
 * is answered `NOT_FOUND`, and a half-written upload's temporary file stays
 * behind beside its destination.
 */
export class ServerTransfers {
  private readonly transfers = new Map<string, Promise<Transfer>>();

  constructor(
    private readonly home: string,
    private readonly limits: TransferLimits,
  ) {}

  /** An upload that fits one chunk and carries its data is written and committed at once. */
  async putOpen(identity: string, request: PutOpenRequest): Promise<TransferOpened> {
    const { transferId, data } = request;
    const opened = await this.opening(identity, transferId, 'put', () =>
      this.createUpload(request),
    );
    if (data === undefined || request.size > this.limits.chunkBytes) return opened;
    await this.putChunk(identity, { v: 1, op: 'put-chunk', transferId, offset: 0, data });
    return { ...(await this.putCommit(identity, transferId)), committed: true };
  }

  async putChunk(identity: string, request: PutChunkRequest): Promise<PutChunkResult> {
    const upload = await this.find(identity, request.transferId, 'put');
    const data = Buffer.from(request.data, 'base64');
    if (data.length > this.limits.chunkBytes) {
      fail(
        'PAYLOAD_TOO_LARGE',
        `chunk is ${data.length} bytes; this server takes at most ${this.limits.chunkBytes}`,
      );
    }
    if (request.offset + data.length > upload.opened.size) {
      fail('BAD_REQUEST', 'chunk ends past the declared file size');
    }
    // A late duplicate after the commit has nothing left to write to.
    if (!upload.closed) await upload.handle.write(data, 0, data.length, request.offset);
    return { written: data.length };
  }

  async putCommit(identity: string, transferId: string): Promise<TransferOpened> {
    const upload = await this.find(identity, transferId, 'put');
    upload.commit ??= this.commit(upload);
    return upload.commit;
  }

  /** A file within the client's `inline` and one chunk comes back whole, and the transfer ends. */
  async getOpen(identity: string, request: GetOpenRequest): Promise<TransferOpened> {
    const { transferId, inline } = request;
    const opened = await this.opening(identity, transferId, 'get', () =>
      this.createDownload(request),
    );
    if (inline === undefined || opened.size > Math.min(inline, this.limits.chunkBytes)) {
      return opened;
    }
    const chunk = { v: 1, op: 'get-chunk', transferId, offset: 0, length: opened.size } as const;
    const { data } = await this.getChunk(identity, chunk);
    await this.close(identity, transferId);
    return { ...opened, data };
  }

  async list(path: string): Promise<ListResult> {
    const resolved = resolve(this.resolve(path));
    return { path: resolved, ...(await walk(resolved)) };
  }

  async mkdir(request: MkdirRequest): Promise<MkdirResult> {
    const root = await destination(this.resolve(request.path), request.name, 'dir');
    await makeTree(root, request.mode, request.dirs);
    return { path: root };
  }

  async getChunk(identity: string, request: GetChunkRequest): Promise<GetChunkResult> {
    const download = await this.find(identity, request.transferId, 'get');
    if (request.length > this.limits.chunkBytes) {
      fail(
        'PAYLOAD_TOO_LARGE',
        `this server sends at most ${this.limits.chunkBytes} bytes per chunk`,
      );
    }
    const length = Math.max(0, Math.min(request.length, download.opened.size - request.offset));
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await download.handle.read(buffer, 0, length, request.offset);
    return { data: buffer.subarray(0, bytesRead).toString('base64') };
  }

  async close(identity: string, transferId: string): Promise<TransferCloseResult> {
    const key = transferKey(identity, transferId);
    const pending = this.transfers.get(key);
    if (!pending) return { closed: false };
    this.transfers.delete(key);
    const transfer = await pending.catch(() => undefined);
    if (transfer) await discard(transfer);
    return { closed: transfer !== undefined };
  }

  /** Drops transfers idle past the limit, removing uploads that were never committed. */
  async sweep(now = performance.now()): Promise<void> {
    for (const [key, pending] of this.transfers) {
      const transfer = await pending.catch(() => undefined);
      if (transfer && now - transfer.lastUsed < this.limits.idleMs) continue;
      if (this.transfers.get(key) !== pending) continue;
      this.transfers.delete(key);
      if (transfer) await discard(transfer);
    }
  }

  async closeAll(): Promise<void> {
    const pending = [...this.transfers.values()];
    this.transfers.clear();
    await Promise.all(
      pending.map(async (entry) => {
        const transfer = await entry.catch(() => undefined);
        if (transfer) await discard(transfer);
      }),
    );
  }

  /**
   * The map is checked and filled without an `await` in between, so a
   * duplicate open waits for the first instead of creating a second file.
   */
  private async opening(
    identity: string,
    transferId: string,
    kind: Transfer['kind'],
    create: () => Promise<Transfer>,
  ): Promise<TransferOpened> {
    const key = transferKey(identity, transferId);
    let pending = this.transfers.get(key);
    if (!pending) {
      pending = create();
      this.transfers.set(key, pending);
      const created = pending;
      created.catch(() => {
        if (this.transfers.get(key) === created) this.transfers.delete(key);
      });
    }
    const transfer = await pending;
    if (transfer.kind !== kind) fail('BAD_REQUEST', `transfer ${transferId} is not a ${kind}`);
    transfer.lastUsed = performance.now();
    return transfer.opened;
  }

  private async find<Kind extends Transfer['kind']>(
    identity: string,
    transferId: string,
    kind: Kind,
  ): Promise<Extract<Transfer, { kind: Kind }>> {
    const pending = this.transfers.get(transferKey(identity, transferId));
    const transfer = await pending?.catch(() => undefined);
    if (!transfer) {
      fail(
        'NOT_FOUND',
        `no transfer ${transferId}: it expired, was closed, or the server restarted`,
      );
    }
    if (transfer.kind !== kind) fail('BAD_REQUEST', `transfer ${transferId} is not a ${kind}`);
    transfer.lastUsed = performance.now();
    return transfer as Extract<Transfer, { kind: Kind }>;
  }

  private resolve(path: string): string {
    if (path === '~' || path.startsWith('~/')) return resolve(this.home, path.slice(2));
    // `resolve` drops a trailing slash, which `destination` needs to see.
    return resolve(this.home, path) + (path.endsWith('/') && path !== '/' ? '/' : '');
  }

  private async createUpload(request: PutOpenRequest): Promise<Upload> {
    this.checkSize(request.size, request.name);
    const target = await destination(this.resolve(request.path), request.name);
    const temporary = temporaryPath(target, request.transferId);
    const handle = await open(temporary, 'w+', 0o600).catch((error: unknown) => {
      throw fsError(error, dirname(target));
    });
    return {
      kind: 'put',
      handle,
      temporary,
      opened: {
        path: target,
        size: request.size,
        sha256: request.sha256,
        mode: request.mode,
        chunkBytes: this.limits.chunkBytes,
      },
      lastUsed: performance.now(),
      closed: false,
    };
  }

  private async createDownload(request: GetOpenRequest): Promise<Download> {
    const path = this.resolve(request.path);
    const handle = await open(path, 'r').catch((error: unknown) => {
      throw fsError(error, path);
    });
    try {
      const stats = await handle.stat();
      if (stats.isDirectory()) fail('SERVICE_ERROR', `${path} is a directory`);
      if (!stats.isFile()) fail('SERVICE_ERROR', `${path} is not a regular file`);
      this.checkSize(stats.size, path);
      // Hashed once here. The handle stays open, so a rename over the path
      // does not change what is sent; an edit in place shows up as a mismatch
      // on the client.
      const { size, sha256 } = await hashFile(handle);
      this.checkSize(size, path);
      return {
        kind: 'get',
        handle,
        opened: {
          path,
          size,
          sha256,
          mode: stats.mode & 0o777,
          chunkBytes: this.limits.chunkBytes,
        },
        lastUsed: performance.now(),
        closed: false,
      };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private checkSize(size: number, what: string): void {
    if (size > this.limits.capBytes) {
      fail(
        'PAYLOAD_TOO_LARGE',
        `${what} is ${size} bytes; this server's shell.transferCapBytes is ${this.limits.capBytes}`,
      );
    }
  }

  /** Verifies the whole temporary file, then moves it into place in one rename. */
  private async commit(upload: Upload): Promise<TransferOpened> {
    const { opened } = upload;
    try {
      const actual = await hashFile(upload.handle);
      if (actual.size !== opened.size || actual.sha256 !== opened.sha256) {
        fail(
          'SERVICE_ERROR',
          `received ${actual.size} bytes with sha256 ${actual.sha256}, expected ${opened.size} bytes with sha256 ${opened.sha256}; ${opened.path} was not changed`,
        );
      }
      await upload.handle.chmod(opened.mode);
      await upload.handle.sync();
      await closeHandle(upload);
      await rename(upload.temporary, opened.path);
      return opened;
    } catch (error) {
      await discard(upload);
      throw DeadDropError.is(error) ? error : fsError(error, opened.path);
    }
  }
}

async function closeHandle(transfer: Transfer): Promise<void> {
  if (transfer.closed) return;
  transfer.closed = true;
  await transfer.handle.close();
}

/** Closes the handle and, for an upload that never landed, removes its temporary file. */
async function discard(transfer: Transfer): Promise<void> {
  await closeHandle(transfer).catch(() => undefined);
  if (transfer.kind === 'put') await rm(transfer.temporary, { force: true });
}

function transferKey(identity: string, transferId: string): string {
  return `${identity}\0${transferId}`;
}
