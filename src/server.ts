import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import { DeadDropError } from '@fyrlabs/dead-drop/protocol';
import {
  DeadDropRuntime,
  type RequestContext,
  type RuntimeConfig,
  type Workspace,
} from '@fyrlabs/dead-drop/runtime';

import { AuditLog, type AuditEvent } from './audit.js';
import type { ShellConfig } from './config.js';
import { answerHello, openRequest, ReplayGuard, sealAnswer } from './envelope.js';
import { ensureKeyPair, parsePublicKey, type KeyPair, type PublicKey } from './keys.js';
import { JobLedger, type JobRecord } from './ledger.js';
import { RateLimiter } from './limits.js';
import { OutputBuffer, readStored } from './output.js';
import {
  SHELL_CHANNEL_V2,
  SHELL_METHOD,
  SHELL_SERVICE,
  parseRequest,
  type CancelResult,
  type CloseResult,
  type ExecRequest,
  type ExecResponse,
  type JobInfo,
  type JobOutput,
  type JobResult,
  type JobsResult,
  type JobStatus,
  type OutputRequest,
  type PingResult,
  type SessionLost,
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
 * Longest a streamed `exec` or an `output` request waits for output. Each one
 * holds a handler slot meanwhile, so this bounds how long a quiet job can keep
 * one from a ping or a transfer.
 */
const MAX_WAIT_MS = 10_000;

/** Once output arrives, how long an answer waits for more, so a quick command takes one answer. */
const LINGER_MS = 100;

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
  /** Streamed jobs until they finish; after that the ledger answers for them. */
  private readonly streams = new Map<string, Stream>();
  /** Every job queued or running in a session, by id, so `cancel` can reach it. */
  private readonly running = new Map<string, { identity: string; abort: AbortController }>();
  private readonly allowed: Set<string>;
  private readonly authorized: Map<string, PublicKey & { comment: string }>;
  private readonly home: string;
  private readonly transfers: ServerTransfers;
  private readonly env: NodeJS.ProcessEnv;
  private readonly limiter: RateLimiter;
  private readonly startedAt = performance.now();
  private sweeper: NodeJS.Timeout | undefined;
  private stopping = false;

  private constructor(
    private readonly options: ServerOptions,
    private readonly ledger: JobLedger<JobResult>,
    runtime: DeadDropRuntime,
    private readonly hostKey: KeyPair,
    private readonly guard: ReplayGuard,
    private readonly audit: AuditLog,
  ) {
    this.runtime = runtime;
    this.workspace = options.shell.workspace
      ? runtime.workspace(options.shell.workspace)
      : runtime.defaultWorkspace();
    this.allowed = new Set(options.shell.allowV1 ? options.shell.allowControllers : []);
    this.authorized = new Map(
      options.shell.authorizedKeys.map((line) => {
        const key = parsePublicKey(line);
        return [key.fingerprint, key];
      }),
    );
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
    this.limiter = new RateLimiter(options.shell.requestsPerMinute);
  }

  static async start(options: ServerOptions): Promise<ShellServer> {
    assertSupportedPlatform();
    const ledger = new JobLedger<JobResult>(
      options.shell.ledgerDir,
      options.shell.ledgerRetentionMs,
    );
    const { recovered } = await ledger.open();
    const guard = new ReplayGuard(
      join(options.shell.ledgerDir, 'replay.log'),
      options.shell.replayWindowMs,
    );
    await guard.open();
    const audit = new AuditLog(options.shell.auditLog, (error) =>
      runtime.logger.warn('audit log write failed', { error: String(error) }),
    );
    await audit.open();

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
    // Before the runtime starts: a request queued while the server was down is
    // handled as soon as it does, and must not find the channel missing.
    const peerId = (
      config.workspaces.find(({ name }) => name === options.shell.workspace) ?? config.workspaces[0]
    )?.peerId;
    const hostKey = await ensureKeyPair(
      options.shell.hostKey,
      `ddshell-host ${peerId ?? ''}`.trim(),
    );
    await runtime.start();
    const server = new ShellServer(options, ledger, runtime, hostKey, guard, audit);

    for (const jobId of recovered) {
      server.runtime.logger.warn(
        'job was running when the server stopped; it is now unknown and will not be rerun',
        { jobId },
      );
    }
    if (options.shell.authorizedKeys.length === 0 && server.allowed.size === 0) {
      server.runtime.logger.warn('shell.authorizedKeys is empty: every request will be refused');
    }
    if (server.allowed.size > 0) {
      server.runtime.logger.warn(
        'shell.allowV1 is on: protocol v1 trusts peer ids, which any workspace member can claim',
      );
    }
    server.workspace.service(SHELL_SERVICE, {
      [SHELL_METHOD]: (input, context) => server.handle(input, context),
    });
    server.workspace.handle(SHELL_CHANNEL_V2, (payload, context) =>
      server.handleSealed(payload, context),
    );
    const interval = Math.max(10, Math.min(options.shell.idleTimeoutMs / 4, 30_000));
    // Deliberately not unref'd: dead-drop unrefs its own poll timers, and over
    // git or GitHub nothing else holds the event loop open between polls.
    server.sweeper = setInterval(() => void server.sweep(), interval);
    server.runtime.logger.info('shell server ready', {
      workspace: server.workspace.name,
      peerId: server.workspace.identity,
      channel: SHELL_CHANNEL_V2,
      hostKey: hostKey.fingerprint,
      authorizedKeys: [...server.authorized.values()].map(({ fingerprint, comment }) =>
        `${fingerprint} ${comment}`.trim(),
      ),
      ...(server.allowed.size > 0 ? { allowControllers: [...server.allowed] } : {}),
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
    await this.audit.flush();
  }

  /** Protocol v1: the caller is whoever dead-drop says it is. Off unless `allowV1`. */
  private async handle(input: unknown, context: RequestContext): Promise<Answer> {
    // `identity` is the caller's configured peer id. `from` is only where the
    // reply goes and must never decide access.
    if (!this.allowed.has(context.identity)) {
      this.runtime.logger.warn('refused shell.v1 request', { identity: context.identity });
      this.record({
        event: 'refused',
        controller: context.identity,
        code: 'UNAUTHORIZED',
        reason: 'protocol v1',
      });
      throw new DeadDropError(
        'UNAUTHORIZED',
        this.options.shell.allowV1
          ? `peer "${context.identity}" is not in this server's shell.allowControllers`
          : `this server only accepts signed requests: run "ddshell keygen" on the controller and add its public key to the server's shell.authorizedKeys`,
      );
    }
    return this.dispatch(context.identity, input);
  }

  /**
   * Protocol v2: the caller is the key that signed the request. Refusals before
   * the request is opened go back as plain dead-drop errors; everything after,
   * errors included, goes back sealed to that key.
   */
  private async handleSealed(payload: Uint8Array, context: RequestContext): Promise<Uint8Array> {
    let opened;
    try {
      opened = await openRequest(
        payload,
        this.hostKey,
        (id) => this.authorized.get(id),
        this.guard,
      );
    } catch (error) {
      const refusal = DeadDropError.from(error, 'BAD_REQUEST');
      this.runtime.logger.warn('refused shell.v2 request', {
        peer: context.identity,
        error: refusal.message,
      });
      // The key is not trusted yet, so the peer id is the best name there is.
      this.record({
        event: 'refused',
        controller: `peer:${context.identity}`,
        code: refusal.code,
        reason: refusal.message,
      });
      throw error;
    }
    if (opened.kind === 'hello')
      return answerHello(this.hostKey, this.workspace.identity, opened.nonce);
    const identity = `key:${opened.client.fingerprint}`;
    let outcome: { result: unknown } | { error: DeadDropError };
    try {
      outcome = { result: await this.dispatch(identity, opened.request) };
    } catch (error) {
      outcome = { error: DeadDropError.from(error, 'SERVICE_ERROR') };
    }
    return sealAnswer(outcome, opened.client, opened.sig, this.hostKey);
  }

  private async dispatch(identity: string, input: unknown): Promise<Answer> {
    if (this.stopping) {
      throw new DeadDropError('UNSUPPORTED', 'shell server is shutting down', { retryable: true });
    }
    const waitMs = this.limiter.take(identity);
    if (waitMs > 0) {
      const { requestsPerMinute } = this.options.shell;
      this.record({
        event: 'refused',
        controller: identity,
        code: 'RATE_LIMITED',
        reason: 'requestsPerMinute',
      });
      // Not retryable: an immediate retry would only be refused again.
      throw new DeadDropError(
        'RATE_LIMITED',
        `more than ${requestsPerMinute} requests a minute from this controller (shell.requestsPerMinute); try again in ${Math.ceil(waitMs / 1000)} s`,
        { retryable: false },
      );
    }
    const request = parseRequest(input);
    if (request.op === 'ping') {
      return {
        version: VERSION,
        deadDropVersion: DEAD_DROP_VERSION,
        uptimeMs: Math.round(performance.now() - this.startedAt),
      };
    }
    if (request.op === 'sessions') return this.list(identity);
    if (request.op === 'jobs') return this.jobs(identity);
    if (request.op === 'job') return this.job(identity, request.jobId);
    if (request.op === 'output') return this.output(identity, request);
    if (request.op === 'cancel') return this.cancel(identity, request.jobId);
    if (request.op === 'list') return this.transfers.list(request.path);
    if (request.op === 'mkdir') return this.transfers.mkdir(request);
    if (request.op !== 'exec' && request.op !== 'close') {
      return this.transfer(identity, request);
    }
    if (request.op === 'close') {
      const key = sessionKey(identity, request.sessionId);
      const entry = this.sessions.get(key);
      this.sessions.delete(key);
      await entry?.session.close();
      if (entry) {
        this.record({ event: 'session-close', controller: identity, sessionId: request.sessionId });
      }
      return { closed: entry !== undefined };
    }
    return this.exec(identity, request);
  }

  /**
   * Duplicate deliveries of one job can arrive while the first is still
   * running. The in-flight map is checked and filled without an `await` in
   * between, so the second copy waits for the first rather than racing it past
   * the ledger.
   */
  private exec(identity: string, request: ExecRequest): Promise<ExecResponse | JobOutput> {
    if (request.stream) return this.stream(identity, request);
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

  /**
   * Starts a job and answers once `running` is persisted and output appears,
   * the job ends, or the wait runs out. The client asks `output` for the rest,
   * so a long command holds no handler slot. Duplicates join the same job.
   */
  private stream(identity: string, request: ExecRequest): Promise<JobOutput | SessionLost> {
    const { jobId } = request;
    let entry = this.streams.get(jobId);
    if (entry && entry.identity !== identity) return Promise.reject(foreignJob(jobId));
    if (!entry) {
      const buffer = new OutputBuffer(this.options.shell.outputCapBytes);
      let onStart!: () => void;
      const started = new Promise<void>((resolve) => (onStart = resolve));
      const created: Stream = { jobId, identity, buffer, started, settled: started };
      created.settled = this.run(identity, request, { buffer, onStart })
        .then(
          (result) => {
            created.result = result;
          },
          (error: unknown) => {
            created.error = error;
          },
        )
        .finally(() => {
          this.streams.delete(jobId);
          buffer.close();
        });
      this.streams.set(jobId, created);
      entry = created;
    }
    const current = entry;
    return Promise.race([current.started, current.settled]).then(() =>
      this.read(current, 0, request.waitMs),
    );
  }

  private async read(entry: Stream, offset: number, waitMs = 0): Promise<JobOutput | SessionLost> {
    const wait = Math.min(waitMs, MAX_WAIT_MS);
    await entry.buffer.waitFor(offset, wait);
    const over = () => entry.result !== undefined || entry.error !== undefined;
    if (wait > 0 && !over() && entry.buffer.end > offset) {
      await Promise.race([entry.settled, sleep(LINGER_MS)]);
    }
    if (entry.error !== undefined) throw entry.error;
    if (entry.result) {
      return entry.result.state === 'session_lost' ? entry.result : outputOf(entry.result, offset);
    }
    return { jobId: entry.jobId, state: 'running', ...entry.buffer.read(offset) };
  }

  private async output(
    identity: string,
    { jobId, offset, waitMs }: OutputRequest,
  ): Promise<JobOutput | SessionLost> {
    const entry = this.streams.get(jobId);
    if (entry) {
      if (entry.identity !== identity) throw foreignJob(jobId);
      return this.read(entry, offset, waitMs);
    }
    const record = await this.ledger.get(jobId);
    if (!record) throw new DeadDropError('NOT_FOUND', `no job ${jobId} on this server`);
    if (record.identity !== identity) throw foreignJob(jobId);
    if (record.state === 'completed' && record.result) return outputOf(record.result, offset);
    // A job started without `stream` has no output to show until it ends.
    if (this.running.has(jobId)) {
      return { jobId, state: 'running', offset, frames: [], next: offset, end: offset };
    }
    return outputOf(this.unknown(jobId), offset);
  }

  private cancel(identity: string, jobId: string): CancelResult {
    const job = this.running.get(jobId);
    if (!job) return { cancelled: false };
    if (job.identity !== identity) throw foreignJob(jobId);
    // A retried cancel must not signal twice.
    if (!job.abort.signal.aborted) {
      job.abort.abort();
      this.runtime.logger.info('job cancelled', { jobId, identity });
      this.record({ event: 'cancel', controller: identity, jobId });
    }
    return { cancelled: true };
  }

  private async run(
    identity: string,
    request: ExecRequest,
    { buffer, onStart }: { buffer?: OutputBuffer; onStart?: () => void } = {},
  ): Promise<ExecResponse> {
    const { jobId } = request;
    const existing = await this.ledger.get(jobId);
    if (existing) {
      if (existing.identity !== identity) throw foreignJob(jobId);
      this.runtime.logger.info('replaying recorded job', { jobId, state: existing.state });
      const replayed =
        existing.state === 'completed' && existing.result
          ? { ...existing.result, replayed: true }
          : this.unknown(jobId);
      this.recordJob(identity, request.sessionId, replayed);
      return replayed;
    }

    const key = sessionKey(identity, request.sessionId);
    let session = this.sessions.get(key)?.session;
    if (session?.closed) {
      this.sessions.delete(key);
      session = undefined;
    }
    if (!session) {
      if (!request.open) {
        this.record({
          event: 'exec',
          controller: identity,
          jobId,
          sessionId: request.sessionId,
          state: 'session_lost',
        });
        return {
          jobId,
          state: 'session_lost',
          message:
            'this shell session no longer exists on the server (idle timeout, exit, or server restart); the command was not run',
        };
      }
      const { maxSessions } = this.options.shell;
      if (this.live(identity).length >= maxSessions) {
        this.record({
          event: 'refused',
          controller: identity,
          code: 'RATE_LIMITED',
          reason: 'maxSessions',
        });
        throw new DeadDropError(
          'RATE_LIMITED',
          `this controller already has ${maxSessions} open sessions (shell.maxSessions); close one, or let one reach the idle timeout, and try again. The command was not run`,
          { retryable: false },
        );
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
      this.record({ event: 'session-open', controller: identity, sessionId: request.sessionId });
    }

    const startedAt = Date.now();
    await this.ledger.put({
      jobId,
      identity,
      sessionId: request.sessionId,
      state: 'running',
      startedAt,
    });
    const abort = new AbortController();
    this.running.set(jobId, { identity, abort });
    onStart?.();
    let outcome;
    try {
      outcome = await session.run(request.command, {
        signal: abort.signal,
        ...(buffer ? { sink: (fd: 1 | 2, bytes: Buffer) => buffer.append(fd, bytes) } : {}),
      });
    } finally {
      this.running.delete(jobId);
    }
    const bytes = buffer ? buffer.end : outcome.stdout.length + outcome.stderr.length;
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
      ...(outcome.cancelled ? { cancelled: true } : {}),
      ...(buffer ? { output: buffer.snapshot() } : {}),
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
      bytes,
      truncated: outcome.truncated,
      timedOut: outcome.timedOut,
      cancelled: outcome.cancelled,
    });
    this.recordJob(identity, request.sessionId, result, bytes);
    if (result.sessionClosed) {
      this.record({ event: 'session-close', controller: identity, sessionId: request.sessionId });
    }
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
        this.record({ event: 'put', controller: identity, transferId, bytes: opened.size });
        return opened;
      }
      case 'get-open': {
        const opened = await this.transfers.getOpen(identity, request);
        this.runtime.logger.info('file sending', { identity, transferId, bytes: opened.size });
        this.record({ event: 'get', controller: identity, transferId, bytes: opened.size });
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
    const sessions = this.live(identity).map(({ sessionId, name, session }) => ({
      sessionId,
      ...(name ? { name } : {}),
      ...(session.pid ? { pid: session.pid } : {}),
      cwd: session.cwd,
      idleMs: session.busy ? 0 : Math.round(now - session.lastUsed),
      busy: session.busy,
    }));
    return { home: this.home, sessions };
  }

  /** Only the caller's own jobs. The ledger holds no command text, so there is none to show. */
  private async jobs(identity: string): Promise<JobsResult> {
    const records = (await this.ledger.list()).filter((record) => record.identity === identity);
    records.sort((a, b) => b.startedAt - a.startedAt);
    return { now: Date.now(), jobs: records.map(jobInfo) };
  }

  private async job(identity: string, jobId: string): Promise<JobStatus> {
    const record = await this.ledger.get(jobId);
    if (!record) throw new DeadDropError('NOT_FOUND', `no job ${jobId} on server`);
    if (record.identity !== identity) throw foreignJob(jobId);
    return { now: Date.now(), job: jobInfo(record) };
  }

  private live(identity: string): Entry[] {
    return [...this.sessions.values()].filter(
      (entry) => entry.identity === identity && !entry.session.closed,
    );
  }

  /** Adds the key's comment, so a person reading the log need not look fingerprints up. */
  private record(event: AuditEvent): void {
    const name = event.controller.startsWith('key:')
      ? this.authorized.get(event.controller.slice(4))?.comment
      : undefined;
    this.audit.record(name ? { ...event, name } : event);
  }

  private recordJob(identity: string, sessionId: string, result: JobResult, bytes?: number): void {
    this.record({
      event: 'exec',
      controller: identity,
      jobId: result.jobId,
      sessionId,
      state: result.state,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ...(bytes === undefined ? {} : { bytes }),
      truncated: result.truncated,
      timedOut: result.timedOut,
      replayed: result.replayed,
      ...(result.cancelled ? { cancelled: true } : {}),
    });
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
    for (const [key, { identity, sessionId, session }] of this.sessions) {
      if (session.busy) continue;
      if (!session.closed && now - session.lastUsed < this.options.shell.idleTimeoutMs) continue;
      this.sessions.delete(key);
      this.runtime.logger.info('shell session closed after idle timeout', { pid: session.pid });
      await session.close();
      this.record({ event: 'session-close', controller: identity, sessionId });
    }
    this.limiter.sweep();
    await this.transfers.sweep();
    await this.guard.compact().catch((error: unknown) => {
      this.runtime.logger.warn('replay log compaction failed', { error: String(error) });
    });
    await this.ledger.prune().catch((error: unknown) => {
      this.runtime.logger.warn('ledger prune failed', { error: String(error) });
    });
  }
}

type Answer =
  | ExecResponse
  | JobOutput
  | CancelResult
  | CloseResult
  | PingResult
  | SessionsResult
  | JobsResult
  | JobStatus
  | TransferResponse;

interface Stream {
  jobId: string;
  identity: string;
  buffer: OutputBuffer;
  /** Resolves once `running` is persisted. */
  started: Promise<void>;
  /** Resolves once the job is over, with `result` or `error` set. */
  settled: Promise<void>;
  result?: ExecResponse;
  error?: unknown;
}

/** A finished job's output from `offset`, with its result once nothing is left to read. */
function outputOf(result: JobResult, offset: number): JobOutput {
  const { output, ...rest } = result;
  const stored = output ?? {
    start: 0,
    frames: [
      { fd: 1 as const, data: result.stdout },
      { fd: 2 as const, data: result.stderr },
    ].filter(({ data }) => data !== ''),
  };
  const slice = readStored(stored, offset);
  return {
    jobId: result.jobId,
    state: result.state,
    ...slice,
    ...(slice.next >= slice.end ? { result: { ...rest, stdout: '', stderr: '' } } : {}),
  };
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

function jobInfo({ result, ...record }: JobRecord<JobResult>): JobInfo {
  return {
    jobId: record.jobId,
    sessionId: record.sessionId,
    state: record.state,
    startedAt: record.startedAt,
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    ...(result === undefined
      ? {}
      : {
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          truncated: result.truncated,
          timedOut: result.timedOut,
          ...(result.cancelled ? { cancelled: true } : {}),
        }),
  };
}

function foreignJob(jobId: string): DeadDropError {
  return new DeadDropError('UNAUTHORIZED', `job ${jobId} belongs to another controller`);
}
