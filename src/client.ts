import { randomBytes, randomUUID } from 'node:crypto';

import { DeadDropRuntime, type RuntimeConfig, type Workspace } from '@fyrlabs/dead-drop/runtime';

import type { ShellConfig } from './config.js';
import {
  SHELL_CHANNEL,
  type CloseRequest,
  type CloseResult,
  type ExecRequest,
  type ExecResponse,
} from './protocol.js';

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

/** Maps a target name to an agent peer id. An unmapped name is taken as a peer id. */
export function resolveTarget(shell: ShellConfig, target: string): string {
  return shell.targets[target] ?? target;
}

/**
 * Controller side. Embeds its own runtime for the life of the process, under a
 * per-process mailbox address so it can share a config file with a `ddrop
 * start` on the same machine without the two fighting over one inbox. The
 * agent still sees the configured peer id as the caller's identity.
 */
export class ShellClient {
  private constructor(
    readonly runtime: DeadDropRuntime,
    private readonly workspace: Workspace,
  ) {}

  static async start(options: ClientOptions): Promise<ShellClient> {
    const runtime = new DeadDropRuntime({
      config: { ...options.runtime, logLevel: options.debug ? 'debug' : 'warn' },
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

  async stop(): Promise<void> {
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
   * again for the same job: the agent answers from its ledger instead of
   * running the command twice.
   */
  async exec(
    command: string,
    options: { timeoutMs?: number; jobId?: string; close?: boolean } = {},
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
    // the same job as a duplicate. The agent's ledger deduplicates jobs instead.
    const response = await this.workspace.call<ExecResponse>(this.peer, SHELL_CHANNEL, request, {
      timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
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
