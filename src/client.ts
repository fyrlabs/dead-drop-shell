import { randomBytes, randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';

import { DeadDropError } from '@fyrlabs/dead-drop/protocol';
import { DeadDropRuntime, type RuntimeConfig, type Workspace } from '@fyrlabs/dead-drop/runtime';

import type { ShellConfig } from './config.js';
import {
  SHELL_CHANNEL,
  type CloseRequest,
  type CloseResult,
  type ExecRequest,
  type ExecResponse,
  type PingRequest,
  type PingResult,
  type GetChunkResult,
  type TransferOpened,
  type TransferRequest,
} from './protocol.js';
import { destination, hashFile, temporaryPath } from './transfer.js';

export interface ClientOptions {
  runtime: RuntimeConfig;
  shell: ShellConfig;
  baseDir?: string;
  /** Show runtime logs at debug level instead of warnings only. */
  debug?: boolean;
}

/**
 * Commands wait on a git push, a poll and a second push, and then on the
 * command itself. The workspace default of 30s is tuned for RPC, not builds.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/** Chunk requests kept in flight at once, so a slow transport's latency overlaps. */
const TRANSFER_WINDOW = 4;

/** Tries per transfer request. Every step is idempotent on the server, so a retry is safe. */
const TRANSFER_ATTEMPTS = 3;

export interface TransferOptions {
  /** Per request, not for the whole file. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called as chunks land, with bytes done so far and the file size. */
  onProgress?: (done: number, total: number) => void;
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

  private constructor(
    readonly runtime: DeadDropRuntime,
    readonly workspace: Workspace,
  ) {}

  static async start(options: ClientOptions): Promise<ShellClient> {
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
    return new ShellClient(runtime, workspace);
  }

  /** Opens a session handle. Nothing is sent until the first command. */
  session(peer: string): RemoteSession {
    return new RemoteSession(this.workspace, peer);
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
      result = await this.workspace.call<PingResult>(peer, SHELL_CHANNEL, request, {
        timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
      });
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
      const opened = await this.transfer<TransferOpened>(peer, options, {
        v: 1,
        op: 'put-open',
        transferId,
        path: remote,
        name: basename(local),
        size,
        sha256,
        mode: stats.mode & 0o777,
      });
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
    });
    try {
      const target = await destination(local, basename(opened.path));
      const temporary = temporaryPath(target, transferId);
      const handle = await open(temporary, 'w+', 0o600);
      try {
        await chunked(opened.size, opened.chunkBytes, options, async (offset, length) => {
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
      return { ...opened, path: target };
    } finally {
      await this.transfer(peer, {}, { v: 1, op: 'transfer-close', transferId }).catch(
        () => undefined,
      );
    }
  }

  private async transfer<Result>(
    peer: string,
    options: TransferOptions,
    request: TransferRequest,
  ): Promise<Result> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        // No `idempotencyKey`, for the same reason as `exec`.
        return await this.workspace.call<Result>(peer, SHELL_CHANNEL, request, {
          timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
          ...(options.signal ? { signal: options.signal } : {}),
        });
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
  readonly id = randomUUID();
  private opened = false;

  constructor(
    private readonly workspace: Workspace,
    readonly peer: string,
  ) {}

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
      ...(this.opened ? {} : { open: true }),
      ...(options.close ? { close: true } : {}),
    };
    // No `idempotencyKey`: the mailbox would then drop a deliberate re-ask for
    // the same job as a duplicate. The server's ledger deduplicates jobs instead.
    const response = await this.workspace.call<ExecResponse>(this.peer, SHELL_CHANNEL, request, {
      timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    this.opened = true;
    return response;
  }

  async close(timeoutMs = 30_000): Promise<void> {
    if (!this.opened) return;
    const request: CloseRequest = { v: 1, op: 'close', sessionId: this.id };
    await this.workspace.call<CloseResult>(this.peer, SHELL_CHANNEL, request, { timeoutMs });
  }
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
