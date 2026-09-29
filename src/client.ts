import { randomBytes, randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { DeadDropError, decodeJson, isErrorPayload } from '@fyrlabs/dead-drop/protocol';
import { DeadDropRuntime, type RuntimeConfig, type Workspace } from '@fyrlabs/dead-drop/runtime';

import type { ShellConfig } from './config.js';
import { helloRequest, openAnswer, openHello, SEALED_TYPE, sealCall } from './envelope.js';
import { KnownHosts, readKeyPair, type KeyPair, type PublicKey } from './keys.js';
import {
  SHELL_CHANNEL,
  SHELL_CHANNEL_V2,
  type CloseRequest,
  type CloseResult,
  type ExecRequest,
  type ExecResponse,
  type PingRequest,
  type PingResult,
  type SessionsRequest,
  type SessionsResult,
  type GetChunkResult,
  type ListRequest,
  type ListResult,
  type MkdirRequest,
  type MkdirResult,
  type TransferOpened,
  type TreeEntry,
  type TransferRequest,
  type ShellRequest,
  namedSessionId,
} from './protocol.js';
import { destination, hashFile, makeTree, temporaryPath, walk } from './transfer.js';

export interface ClientOptions {
  runtime: RuntimeConfig;
  shell: ShellConfig;
  baseDir?: string;
  /** Show runtime logs at debug level instead of warnings only. */
  debug?: boolean;
  /** Told when a server's host key is pinned on first use. */
  onNewHost?: (peer: string, fingerprint: string) => void;
}

interface CallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Sends one shell request to `peer` and resolves to its answer. */
export type ShellCall = <Result>(
  peer: string,
  request: ShellRequest,
  options: CallOptions,
) => Promise<Result>;

/**
 * Commands wait on a git push, a poll and a second push, and then on the
 * command itself. The workspace default of 30s is tuned for RPC, not builds.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/** Chunk requests kept in flight at once, so a slow transport's latency overlaps. */
const TRANSFER_WINDOW = 4;

/** Files this size or smaller travel inside the open request and its answer: one round trip. */
const INLINE_BYTES = 64 * 1024;

/** Files of a recursive copy kept in flight at once. */
const FILE_WINDOW = 4;

/** Tries per transfer request. Every step is idempotent on the server, so a retry is safe. */
const TRANSFER_ATTEMPTS = 3;

export interface TransferOptions {
  /** Per request, not for the whole file. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called as chunks land, with bytes done so far and the file size. */
  onProgress?: (done: number, total: number) => void;
}

/** What a recursive copy did. It carries on past a file that fails, as scp -r does. */
export interface TreeCopy {
  /** Where the top landed. */
  path: string;
  files: number;
  bytes: number;
  failed: Array<{ path: string; error: unknown }>;
  /** Left out on the sending side: special files, broken links, loops, unreadable directories. */
  skipped: Array<{ path: string; reason: string }>;
}

/** Maps a target name to a server peer id. An unmapped name is taken as a peer id. */
export function resolveTarget(shell: ShellConfig, target: string): string {
  return shell.targets[target] ?? target;
}

/**
 * Controller side. Embeds its own runtime for the life of the process, under a
 * per-process mailbox address so it can share a config file with a `ddrop
 * start` on the same machine without the two fighting over one inbox. The
 * server still sees the configured peer id as the caller's identity.
 */
export class ShellClient {
  // dead-drop unrefs its poll and timeout timers, and over git or GitHub nothing
  // else holds the event loop open, so Node would exit mid-request.
  private readonly keepAlive = setInterval(() => undefined, 1 << 30);
  private readonly hosts = new Map<string, Promise<PublicKey>>();
  private readonly knownHosts: KnownHosts;
  readonly call: ShellCall;

  private constructor(
    readonly runtime: DeadDropRuntime,
    readonly workspace: Workspace,
    private readonly options: ClientOptions,
    /** Without a key the client speaks protocol v1. */
    readonly key: KeyPair | undefined,
  ) {
    this.knownHosts = new KnownHosts(options.shell.knownHosts);
    this.call = key
      ? (peer, request, callOptions) => this.sealed(key, peer, request, callOptions)
      : (peer, request, callOptions) =>
          this.workspace.call(peer, SHELL_CHANNEL, request, requestOptions(callOptions));
  }

  static async start(options: ClientOptions): Promise<ShellClient> {
    const key = await readKeyPair(options.shell.key).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    const runtime = new DeadDropRuntime({
      config: { ...options.runtime, logLevel: options.debug ? 'debug' : 'silent' },
      sessionId: randomBytes(4).toString('hex'),
      logFormat: 'pretty',
      ...(options.baseDir ? { baseDir: options.baseDir } : {}),
    });
    await runtime.start();
    const workspace = options.shell.workspace
      ? runtime.workspace(options.shell.workspace)
      : runtime.defaultWorkspace();
    return new ShellClient(runtime, workspace, options, key);
  }

  /** Protocol v2: signed by this controller's key, sealed to the server's pinned host key. */
  private async sealed<Result>(
    key: KeyPair,
    peer: string,
    request: ShellRequest,
    options: CallOptions,
  ): Promise<Result> {
    const host = await this.hostKey(peer, options);
    const { bytes, sig } = sealCall(request as unknown as Record<string, unknown>, key, host);
    const response = await this.workspace.request(peer, SHELL_CHANNEL_V2, bytes, {
      ...requestOptions(options),
      headers: { accept: SEALED_TYPE },
    });
    if (response.contentType !== SEALED_TYPE) throw this.refusal(peer, response.payload);
    return openAnswer<Result>(response.payload, key, host, sig);
  }

  /**
   * The host key pinned for `peer`, or, on first contact, the one it proves it
   * holds, pinned from then on. A later change is refused, as ssh does.
   */
  private hostKey(peer: string, options: CallOptions): Promise<PublicKey> {
    let pending = this.hosts.get(peer);
    if (!pending) {
      pending = this.pin(peer, options);
      this.hosts.set(peer, pending);
      pending.catch(() => this.hosts.delete(peer));
    }
    return pending;
  }

  private async pin(peer: string, options: CallOptions): Promise<PublicKey> {
    const known = await this.knownHosts.get(peer);
    if (known) return known;
    if (this.options.shell.strictHostKeys) {
      throw new DeadDropError(
        'UNAUTHORIZED',
        `no host key for ${peer} in ${this.options.shell.knownHosts}; add the line "ddshell hostkey" prints on the server`,
      );
    }
    const { bytes, nonce } = helloRequest();
    const response = await this.workspace.request(peer, SHELL_CHANNEL_V2, bytes, {
      ...requestOptions(options),
      headers: { accept: SEALED_TYPE },
    });
    if (response.contentType !== SEALED_TYPE) throw this.refusal(peer, response.payload);
    const key = openHello(response.payload, peer, nonce);
    await this.knownHosts.add(peer, key);
    this.options.onNewHost?.(peer, key.fingerprint);
    return key;
  }

  /** A plain dead-drop error: the server refused before it could seal an answer. */
  private refusal(peer: string, payload: Uint8Array): DeadDropError {
    const decoded = decodeJson(payload);
    if (!isErrorPayload(decoded)) {
      return new DeadDropError(
        'DECODE_FAILED',
        `${peer} sent an answer that is neither sealed nor an error`,
      );
    }
    const error = DeadDropError.fromJSON(decoded.error);
    if (error.code === 'NOT_FOUND' && error.message.includes(SHELL_CHANNEL_V2)) {
      return new DeadDropError(
        'UNSUPPORTED',
        `${peer} runs ddshell without signed requests (protocol v2); upgrade it`,
      );
    }
    if (/sealed to host key/.test(error.message)) {
      return new DeadDropError(
        'UNAUTHORIZED',
        `${error.message}. The server's host key changed. If that was deliberate, remove the ${peer} line from ${this.options.shell.knownHosts}; otherwise something is impersonating it`,
      );
    }
    return error;
  }

  /**
   * Opens a session handle. Nothing is sent until the first command. A named
   * session's first command joins the live session of that name, if there is
   * one, instead of starting a shell.
   */
  session(peer: string, name?: string): RemoteSession {
    return new RemoteSession(this.call, peer, name);
  }

  /** The caller's live sessions on `peer`. */
  async sessions(
    peer: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<SessionsResult> {
    const request: SessionsRequest = { v: 1, op: 'sessions' };
    try {
      return await this.call<SessionsResult>(peer, request, options);
    } catch (error) {
      if (
        DeadDropError.is(error) &&
        error.code === 'BAD_REQUEST' &&
        /sessionId|unknown shell operation/.test(error.message)
      ) {
        throw new DeadDropError(
          'UNSUPPORTED',
          `${peer} runs a ddshell without session listing; upgrade it to list sessions`,
        );
      }
      throw error;
    }
  }

  /**
   * One round trip that runs nothing. `result` is undefined for a server older
   * than `ping`: it refuses the request, which still proves it is up.
   */
  async ping(
    peer: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ result: PingResult | undefined; roundTripMs: number }> {
    const started = performance.now();
    const request: PingRequest = { v: 1, op: 'ping' };
    let result: PingResult | undefined;
    try {
      result = await this.call<PingResult>(peer, request, options);
    } catch (error) {
      // Only the server's own request parser answers BAD_REQUEST, and 0.1.0's
      // refuses a ping before it gets as far as naming the operation.
      if (!(DeadDropError.is(error) && error.code === 'BAD_REQUEST')) throw error;
    }
    return { result, roundTripMs: Math.round(performance.now() - started) };
  }

  /**
   * Uploads a regular file. It lands atomically: the server writes a
   * temporary file beside `remote` and renames it into place only once its
   * size and sha256 match the local file's. Resolves to where it landed.
   */
  async put(
    peer: string,
    local: string,
    remote: string,
    options: TransferOptions = {},
  ): Promise<TransferOpened> {
    const handle = await open(local, 'r');
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw new DeadDropError('BAD_REQUEST', `${local} is not a regular file`);
      }
      const { size, sha256 } = await hashFile(handle);
      const transferId = randomUUID();
      const whole = size <= INLINE_BYTES ? Buffer.alloc(size) : undefined;
      if (whole) await handle.read(whole, 0, size, 0);
      const opened = await this.transfer<TransferOpened>(peer, options, {
        v: 1,
        op: 'put-open',
        transferId,
        path: remote,
        name: basename(local),
        size,
        sha256,
        mode: stats.mode & 0o777,
        ...(whole ? { data: whole.toString('base64') } : {}),
      });
      if (opened.committed) {
        options.onProgress?.(size, size);
        return opened;
      }
      try {
        await chunked(size, opened.chunkBytes, options, async (offset, length) => {
          const data = Buffer.alloc(length);
          await handle.read(data, 0, length, offset);
          await this.transfer(peer, options, {
            v: 1,
            op: 'put-chunk',
            transferId,
            offset,
            data: data.toString('base64'),
          });
        });
        return await this.transfer<TransferOpened>(peer, options, {
          v: 1,
          op: 'put-commit',
          transferId,
        });
      } catch (error) {
        await this.transfer(peer, {}, { v: 1, op: 'transfer-close', transferId }).catch(
          () => undefined,
        );
        throw error;
      }
    } finally {
      await handle.close();
    }
  }

  /**
   * Downloads a regular file into a temporary file beside `local`, checks its
   * size and sha256 against what the server hashed when the transfer opened,
   * and renames it into place. Resolves to where it landed.
   */
  async get(
    peer: string,
    remote: string,
    local: string,
    options: TransferOptions = {},
  ): Promise<TransferOpened> {
    const transferId = randomUUID();
    const opened = await this.transfer<TransferOpened>(peer, options, {
      v: 1,
      op: 'get-open',
      transferId,
      path: remote,
      inline: INLINE_BYTES,
    });
    // An inline answer has already released the transfer on the server.
    const inline = opened.data === undefined ? undefined : Buffer.from(opened.data, 'base64');
    try {
      const target = await destination(local, basename(opened.path));
      const temporary = temporaryPath(target, transferId);
      const handle = await open(temporary, 'w+', 0o600);
      try {
        if (inline) {
          await handle.write(inline, 0, inline.length, 0);
          options.onProgress?.(inline.length, opened.size);
        }
        const size = inline ? 0 : opened.size;
        await chunked(size, opened.chunkBytes, options, async (offset, length) => {
          const { data } = await this.transfer<GetChunkResult>(peer, options, {
            v: 1,
            op: 'get-chunk',
            transferId,
            offset,
            length,
          });
          const bytes = Buffer.from(data, 'base64');
          await handle.write(bytes, 0, bytes.length, offset);
        });
        const actual = await hashFile(handle);
        if (actual.size !== opened.size || actual.sha256 !== opened.sha256) {
          throw new DeadDropError(
            'SERVICE_ERROR',
            `${opened.path} changed on the target during the transfer; ${target} was not changed`,
          );
        }
        await handle.chmod(opened.mode);
        await handle.sync();
      } catch (error) {
        await handle.close();
        await rm(temporary, { force: true });
        throw error;
      }
      await handle.close();
      await rename(temporary, target);
      const { data: _data, ...landed } = opened;
      return { ...landed, path: target };
    } finally {
      if (!inline) {
        await this.transfer(peer, {}, { v: 1, op: 'transfer-close', transferId }).catch(
          () => undefined,
        );
      }
    }
  }

  /**
   * Uploads a file or a whole directory, as `scp -r`. The directory tree is
   * created in one request, then files go a few at a time.
   */
  async putTree(
    peer: string,
    local: string,
    remote: string,
    options: TransferOptions = {},
  ): Promise<TreeCopy> {
    const tree = await walk(local);
    if (tree.kind === 'file') return single(await this.put(peer, local, remote, options));
    const request: MkdirRequest = {
      v: 1,
      op: 'mkdir',
      path: remote,
      name: basename(resolve(local)),
      mode: tree.mode,
      dirs: tree.entries.flatMap(({ kind, path, mode }) =>
        kind === 'dir' ? [{ path, mode }] : [],
      ),
    };
    const { path: root } = await this.treeCall<MkdirResult>(peer, options, request);
    return copyFiles(root, tree, options, (file, fileOptions) =>
      this.put(
        peer,
        join(local, file.path),
        `${posix.join(root, posix.dirname(file.path))}/`,
        fileOptions,
      ),
    );
  }

  /** Downloads a file or a whole directory, as `scp -r`. */
  async getTree(
    peer: string,
    remote: string,
    local: string,
    options: TransferOptions = {},
  ): Promise<TreeCopy> {
    const tree = await this.treeCall<ListResult>(peer, options, { v: 1, op: 'list', path: remote });
    if (tree.kind === 'file') return single(await this.get(peer, remote, local, options));
    const root = await destination(local, basename(tree.path), 'dir');
    const dirs = tree.entries.filter((entry) => entry.kind === 'dir');
    await makeTree(root, tree.mode, dirs);
    return copyFiles(root, tree, options, (file, fileOptions) =>
      this.get(
        peer,
        posix.join(tree.path, file.path),
        `${join(root, dirname(file.path))}/`,
        fileOptions,
      ),
    );
  }

  /** `list` and `mkdir` arrived with recursive copy. An older server refuses them as sessionless commands. */
  private async treeCall<Result>(
    peer: string,
    options: TransferOptions,
    request: TransferRequest | MkdirRequest | ListRequest,
  ): Promise<Result> {
    try {
      return await this.transfer<Result>(peer, options, request);
    } catch (error) {
      if (
        DeadDropError.is(error) &&
        error.code === 'BAD_REQUEST' &&
        /sessionId/.test(error.message)
      ) {
        throw new DeadDropError(
          'UNSUPPORTED',
          `${peer} runs a ddshell without recursive copy; upgrade it to copy directories`,
        );
      }
      throw error;
    }
  }

  private async transfer<Result>(
    peer: string,
    options: TransferOptions,
    request: TransferRequest | MkdirRequest | ListRequest,
  ): Promise<Result> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        // No `idempotencyKey`, for the same reason as `exec`.
        return await this.call<Result>(peer, request, options);
      } catch (error) {
        const retry = attempt < TRANSFER_ATTEMPTS && DeadDropError.is(error) && error.retryable;
        if (!retry || options.signal?.aborted) throw error;
      }
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.keepAlive);
    await this.runtime.stop();
  }
}

export class RemoteSession {
  readonly id: string;
  private opened = false;

  constructor(
    private readonly call: ShellCall,
    readonly peer: string,
    readonly name?: string,
  ) {
    this.id = name === undefined ? randomUUID() : namedSessionId(name);
  }

  /**
   * Runs one command. `jobId` is exposed so a caller that timed out can ask
   * again for the same job: the server answers from its ledger instead of
   * running the command twice.
   */
  async exec(
    command: string,
    options: { timeoutMs?: number; jobId?: string; close?: boolean; signal?: AbortSignal } = {},
  ): Promise<ExecResponse> {
    const request: ExecRequest = {
      v: 1,
      op: 'exec',
      sessionId: this.id,
      jobId: options.jobId ?? randomUUID(),
      command,
      ...(this.opened ? {} : { open: true, ...(this.name ? { name: this.name } : {}) }),
      ...(options.close ? { close: true } : {}),
    };
    // No `idempotencyKey`: the mailbox would then drop a deliberate re-ask for
    // the same job as a duplicate. The server's ledger deduplicates jobs instead.
    const response = await this.call<ExecResponse>(this.peer, request, options);
    this.opened = true;
    return response;
  }

  async close(timeoutMs = 30_000): Promise<void> {
    if (!this.opened) return;
    const request: CloseRequest = { v: 1, op: 'close', sessionId: this.id };
    await this.call<CloseResult>(this.peer, request, { timeoutMs });
  }
}

function single(landed: TransferOpened): TreeCopy {
  return { path: landed.path, files: 1, bytes: landed.size, failed: [], skipped: [] };
}

/** Copies every file of `tree` a few at a time, recording failures instead of stopping. */
async function copyFiles(
  root: string,
  tree: Pick<ListResult, 'entries' | 'skipped'>,
  options: TransferOptions,
  copy: (file: TreeEntry, options: TransferOptions) => Promise<TransferOpened>,
): Promise<TreeCopy> {
  const files = tree.entries.filter((entry) => entry.kind === 'file');
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const done = new Map<string, number>();
  let finished = 0;
  const result: TreeCopy = { path: root, files: 0, bytes: 0, failed: [], skipped: tree.skipped };
  const worker = async () => {
    while (finished < files.length) {
      const file = files[finished]!;
      finished += 1;
      const onProgress = (bytes: number) => {
        done.set(file.path, bytes);
        let sum = 0;
        for (const value of done.values()) sum += value;
        options.onProgress?.(sum, total);
      };
      try {
        const landed = await copy(file, { ...options, onProgress });
        result.files += 1;
        result.bytes += landed.size;
      } catch (error) {
        result.failed.push({ path: file.path, error });
        if (options.signal?.aborted) return;
      }
    }
  };
  await Promise.all(Array.from({ length: FILE_WINDOW }, worker));
  return result;
}

/**
 * Runs `task` over `[offset, length]` pieces of a `size`-byte file, a few at
 * once. The first failure stops new pieces from starting and is thrown.
 */
async function chunked(
  size: number,
  chunkBytes: number,
  options: TransferOptions,
  task: (offset: number, length: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let done = 0;
  let failed = false;
  const worker = async () => {
    while (next < size && !failed) {
      const offset = next;
      const length = Math.min(chunkBytes, size - offset);
      next += length;
      try {
        await task(offset, length);
      } catch (error) {
        failed = true;
        throw error;
      }
      done += length;
      options.onProgress?.(done, size);
    }
  };
  await Promise.all(Array.from({ length: TRANSFER_WINDOW }, worker));
}

function requestOptions(options: CallOptions): { timeoutMs: number; signal?: AbortSignal } {
  return {
    timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  };
}
