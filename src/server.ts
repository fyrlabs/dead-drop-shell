import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';

import { DeadDropError } from '@fyrlabs/dead-drop/protocol';
import {
  DeadDropRuntime,
  type RequestContext,
  type RuntimeConfig,
  type Workspace,
} from '@fyrlabs/dead-drop/runtime';

import type { ShellConfig } from './config.js';
import { JobLedger } from './ledger.js';
import {
  SHELL_CHANNEL,
  SHELL_METHOD,
  SHELL_SERVICE,
  parseRequest,
  type CloseResult,
  type ExecRequest,
  type ExecResponse,
  type JobResult,
  type PingResult,
  type SessionsResult,
  type TransferRequest,
  type TransferResponse,
} from './protocol.js';
import { ShellSession } from './session.js';
import { ServerTransfers } from './transfer.js';
import { DEAD_DROP_VERSION, VERSION } from './version.js';

export interface ServerOptions {
  runtime: RuntimeConfig;
  shell: ShellConfig;
  baseDir?: string;
  logFormat?: 'json' | 'pretty';
  /** Directory sessions start in. Defaults to the server account's home. */
  home?: string;
}

/**
 * Handlers run one at a time by default, so a single `sleep 60` would hold up
 * every other session. Used when the workspace does not set `concurrency`.
 */
const DEFAULT_CONCURRENCY = 8;

/**
 * Variables that belong to the server, not to the shells it runs. The OS account
 * can still read the secret file the server reads; this only keeps it out of
 * `env` output that might be pasted somewhere.
 */
const PRIVATE_ENV = /^(DEADDROP_|DDSHELL_)/;

export function assertSupportedPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    throw new DeadDropError(
      'UNSUPPORTED',
      'ddshell serve needs a POSIX shell and process groups; Windows is not supported in phase one',
    );
  }
}

export class ShellServer {
  readonly runtime: DeadDropRuntime;
  private readonly workspace: Workspace;
  private readonly sessions = new Map<string, Entry>();
  private readonly inflight = new Map<
    string,
    { identity: string; result: Promise<ExecResponse> }
  >();
  private readonly allowed: Set<string>;
  private readonly home: string;
  private readonly transfers: ServerTransfers;
  private readonly env: NodeJS.ProcessEnv;
  private readonly startedAt = performance.now();
  private sweeper: NodeJS.Timeout | undefined;
  private stopping = false;

  private constructor(
    private readonly options: ServerOptions,
    private readonly ledger: JobLedger<JobResult>,
    runtime: DeadDropRuntime,
  ) {
    this.runtime = runtime;
    this.workspace = options.shell.workspace
      ? runtime.workspace(options.shell.workspace)
      : runtime.defaultWorkspace();
    this.allowed = new Set(options.shell.allowControllers);
    this.home = options.home ?? homedir();
    this.env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !PRIVATE_ENV.test(name)),
    );
    this.env.HOME = this.home;
    this.transfers = new ServerTransfers(this.home, {
      capBytes: options.shell.transferCapBytes,
      chunkBytes: options.shell.transferChunkBytes,
      idleMs: options.shell.idleTimeoutMs,
    });
  }

  static async start(options: ServerOptions): Promise<ShellServer> {
    assertSupportedPlatform();
    const ledger = new JobLedger<JobResult>(
      options.shell.ledgerDir,
      options.shell.ledgerRetentionMs,
    );
    const { recovered } = await ledger.open();

    const config: RuntimeConfig = {
      ...options.runtime,
      workspaces: options.runtime.workspaces.map((workspace) => ({
        ...workspace,
        concurrency: workspace.concurrency ?? DEFAULT_CONCURRENCY,
      })),
    };
    const runtime = new DeadDropRuntime({
      config,
      ...(options.baseDir ? { baseDir: options.baseDir } : {}),
      ...(options.logFormat ? { logFormat: options.logFormat } : {}),
    });
    await runtime.start();
    const server = new ShellServer(options, ledger, runtime);

    for (const jobId of recovered) {
      server.runtime.logger.warn(
        'job was running when the server stopped; it is now unknown and will not be rerun',
        { jobId },
      );
    }
    if (options.shell.allowControllers.length === 0) {
      server.runtime.logger.warn('shell.allowControllers is empty: every request will be refused');
    }
    server.workspace.service(SHELL_SERVICE, {
      [SHELL_METHOD]: (input, context) => server.handle(input, context),
    });
    const interval = Math.max(10, Math.min(options.shell.idleTimeoutMs / 4, 30_000));
    // Deliberately not unref'd: dead-drop unrefs its own poll timers, and over
    // git or GitHub nothing else holds the event loop open between polls.
    server.sweeper = setInterval(() => void server.sweep(), interval);
    server.runtime.logger.info('shell server ready', {
      workspace: server.workspace.name,
      peerId: server.workspace.identity,
      channel: SHELL_CHANNEL,
      allowControllers: options.shell.allowControllers,
    });
    return server;
  }

  /** Process ids of live session shells. For tests and diagnostics. */
  sessionPids(): number[] {
    return [...this.sessions.values()].flatMap(({ session }) => session.pid ?? []);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    clearInterval(this.sweeper);
    await Promise.all([...this.sessions.values()].map(({ session }) => session.close()));
    await this.transfers.closeAll();
    this.sessions.clear();
    await this.runtime.stop();
  }

  private async handle(
    input: unknown,
    context: RequestContext,
  ): Promise<ExecResponse | CloseResult | PingResult | SessionsResult | TransferResponse> {
    // `identity` is the caller's configured peer id. `from` is only where the
    // reply goes and must never decide access.
    if (!this.allowed.has(context.identity)) {
      this.runtime.logger.warn('refused shell request from a peer not in allowControllers', {
        identity: context.identity,
      });
      throw new DeadDropError(
        'UNAUTHORIZED',
        `peer "${context.identity}" is not in this server's shell.allowControllers`,
      );
    }
    if (this.stopping) {
      throw new DeadDropError('UNSUPPORTED', 'shell server is shutting down', { retryable: true });
    }
    const request = parseRequest(input);
    if (request.op === 'ping') {
      return {
        version: VERSION,
        deadDropVersion: DEAD_DROP_VERSION,
        uptimeMs: Math.round(performance.now() - this.startedAt),
      };
    }
    if (request.op === 'sessions') return this.list(context.identity);
    if (request.op === 'list') return this.transfers.list(request.path);
    if (request.op === 'mkdir') return this.transfers.mkdir(request);
    if (request.op !== 'exec' && request.op !== 'close') {
      return this.transfer(context.identity, request);
    }
    if (request.op === 'close') {
      const key = sessionKey(context.identity, request.sessionId);
      const entry = this.sessions.get(key);
      this.sessions.delete(key);
      await entry?.session.close();
      return { closed: entry !== undefined };
    }
    return this.exec(context.identity, request);
  }

  /**
   * Duplicate deliveries of one job can arrive while the first is still
   * running. The in-flight map is checked and filled without an `await` in
   * between, so the second copy waits for the first rather than racing it past
   * the ledger.
   */
  private exec(identity: string, request: ExecRequest): Promise<ExecResponse> {
    const inflight = this.inflight.get(request.jobId);
    if (inflight) {
      if (inflight.identity !== identity) return Promise.reject(foreignJob(request.jobId));
      return inflight.result.then((result) =>
        result.state === 'session_lost' ? result : { ...result, replayed: true },
      );
    }
    const result = this.run(identity, request);
    this.inflight.set(request.jobId, { identity, result });
    void result.finally(() => this.inflight.delete(request.jobId)).catch(() => undefined);
    return result;
  }

  private async run(identity: string, request: ExecRequest): Promise<ExecResponse> {
    const { jobId } = request;
    const existing = await this.ledger.get(jobId);
    if (existing) {
      if (existing.identity !== identity) throw foreignJob(jobId);
      this.runtime.logger.info('replaying recorded job', { jobId, state: existing.state });
      if (existing.state === 'completed' && existing.result) {
        return { ...existing.result, replayed: true };
      }
      return this.unknown(jobId);
    }

    const key = sessionKey(identity, request.sessionId);
    let session = this.sessions.get(key)?.session;
    if (session?.closed) {
      this.sessions.delete(key);
      session = undefined;
    }
    if (!session) {
      if (!request.open) {
        return {
          jobId,
          state: 'session_lost',
          message:
            'this shell session no longer exists on the server (idle timeout, exit, or server restart); the command was not run',
        };
      }
      session = new ShellSession({
        shell: this.options.shell.shell,
        cwd: this.home,
        env: this.env,
        outputCapBytes: this.options.shell.outputCapBytes,
        commandTimeoutMs: this.options.shell.commandTimeoutMs,
      });
      this.sessions.set(key, {
        identity,
        sessionId: request.sessionId,
        ...(request.name ? { name: request.name } : {}),
        session,
      });
      this.runtime.logger.info('shell session opened', {
        identity,
        sessionId: request.sessionId,
        pid: session.pid,
      });
    }

    const startedAt = Date.now();
    await this.ledger.put({
      jobId,
      identity,
      sessionId: request.sessionId,
      state: 'running',
      startedAt,
    });
    const outcome = await session.run(request.command);
    if (outcome.sessionClosed || request.close) {
      this.sessions.delete(key);
      await session.close();
    }
    const result: JobResult = {
      jobId,
      state: 'completed',
      stdout: outcome.stdout.toString('base64'),
      stderr: outcome.stderr.toString('base64'),
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      cwd: outcome.cwd,
      home: this.home,
      truncated: outcome.truncated,
      timedOut: outcome.timedOut,
      sessionClosed: outcome.sessionClosed || request.close === true,
      replayed: false,
    };
    await this.ledger.put({
      jobId,
      identity,
      sessionId: request.sessionId,
      state: 'completed',
      startedAt,
      finishedAt: Date.now(),
      result,
    });
    // Never the command or its output: shell history is not logged by default.
    this.runtime.logger.info('job completed', {
      jobId,
      identity,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      bytes: outcome.stdout.length + outcome.stderr.length,
      truncated: outcome.truncated,
      timedOut: outcome.timedOut,
    });
    return result;
  }

  /**
   * File transfer runs outside sessions and the ledger: every step is
   * idempotent, so a duplicate is answered again rather than deduplicated.
   * Like commands, paths and contents are never logged.
   */
  private async transfer(identity: string, request: TransferRequest): Promise<TransferResponse> {
    const { transferId } = request;
    switch (request.op) {
      case 'put-open':
        return this.transfers.putOpen(identity, request);
      case 'put-chunk':
        return this.transfers.putChunk(identity, request);
      case 'put-commit': {
        const opened = await this.transfers.putCommit(identity, transferId);
        this.runtime.logger.info('file received', { identity, transferId, bytes: opened.size });
        return opened;
      }
      case 'get-open': {
        const opened = await this.transfers.getOpen(identity, request);
        this.runtime.logger.info('file sending', { identity, transferId, bytes: opened.size });
        return opened;
      }
      case 'get-chunk':
        return this.transfers.getChunk(identity, request);
      case 'transfer-close':
        return this.transfers.close(identity, transferId);
    }
  }

  /** Only the caller's own sessions: another controller's are not its business. */
  private list(identity: string): SessionsResult {
    const now = performance.now();
    const sessions = [...this.sessions.values()]
      .filter((entry) => entry.identity === identity && !entry.session.closed)
      .map(({ sessionId, name, session }) => ({
        sessionId,
        ...(name ? { name } : {}),
        ...(session.pid ? { pid: session.pid } : {}),
        cwd: session.cwd,
        idleMs: session.busy ? 0 : Math.round(now - session.lastUsed),
        busy: session.busy,
      }));
    return { home: this.home, sessions };
  }

  private unknown(jobId: string): JobResult {
    return {
      jobId,
      state: 'unknown',
      stdout: '',
      stderr: '',
      exitCode: null,
      durationMs: 0,
      cwd: '',
      home: this.home,
      truncated: false,
      timedOut: false,
      sessionClosed: false,
      replayed: true,
    };
  }

  private async sweep(): Promise<void> {
    const now = performance.now();
    for (const [key, { session }] of this.sessions) {
      if (session.busy) continue;
      if (!session.closed && now - session.lastUsed < this.options.shell.idleTimeoutMs) continue;
      this.sessions.delete(key);
      this.runtime.logger.info('shell session closed after idle timeout', { pid: session.pid });
      await session.close();
    }
    await this.transfers.sweep();
    await this.ledger.prune().catch((error: unknown) => {
      this.runtime.logger.warn('ledger prune failed', { error: String(error) });
    });
  }
}

interface Entry {
  identity: string;
  sessionId: string;
  name?: string;
  session: ShellSession;
}

function sessionKey(identity: string, sessionId: string): string {
  return `${identity}\0${sessionId}`;
}

function foreignJob(jobId: string): DeadDropError {
  return new DeadDropError('UNAUTHORIZED', `job ${jobId} belongs to another controller`);
}
