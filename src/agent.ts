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
} from './protocol.js';
import { ShellSession } from './session.js';

export interface AgentOptions {
  runtime: RuntimeConfig;
  shell: ShellConfig;
  baseDir?: string;
  logFormat?: 'json' | 'pretty';
  /** Directory sessions start in. Defaults to the agent account's home. */
  home?: string;
}

/**
 * Handlers run one at a time by default, so a single `sleep 60` would hold up
 * every other session. Used when the workspace does not set `concurrency`.
 */
const DEFAULT_CONCURRENCY = 8;

/**
 * Variables that belong to the agent, not to the shells it runs. The OS account
 * can still read the secret file the agent reads; this only keeps it out of
 * `env` output that might be pasted somewhere.
 */
const PRIVATE_ENV = /^(DEADDROP_|DDSHELL_)/;

export function assertSupportedPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    throw new DeadDropError(
      'UNSUPPORTED',
      'ddshell agent needs a POSIX shell and process groups; Windows is not supported in phase one',
    );
  }
}

export class ShellAgent {
  readonly runtime: DeadDropRuntime;
  private readonly workspace: Workspace;
  private readonly sessions = new Map<string, ShellSession>();
  private readonly inflight = new Map<
    string,
    { identity: string; result: Promise<ExecResponse> }
  >();
  private readonly allowed: Set<string>;
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private sweeper: NodeJS.Timeout | undefined;
  private stopping = false;

  private constructor(
    private readonly options: AgentOptions,
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
  }

  static async start(options: AgentOptions): Promise<ShellAgent> {
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
    const agent = new ShellAgent(options, ledger, runtime);

    for (const jobId of recovered) {
      agent.runtime.logger.warn(
        'job was running when the agent stopped; it is now unknown and will not be rerun',
        { jobId },
      );
    }
    if (options.shell.allowControllers.length === 0) {
      agent.runtime.logger.warn('shell.allowControllers is empty: every request will be refused');
    }
    agent.workspace.service(SHELL_SERVICE, {
      [SHELL_METHOD]: (input, context) => agent.handle(input, context),
    });
    const interval = Math.max(10, Math.min(options.shell.idleTimeoutMs / 4, 30_000));
    agent.sweeper = setInterval(() => void agent.sweep(), interval);
    agent.sweeper.unref();
    agent.runtime.logger.info('shell agent ready', {
      workspace: agent.workspace.name,
      peerId: agent.workspace.identity,
      channel: SHELL_CHANNEL,
      allowControllers: options.shell.allowControllers,
    });
    return agent;
  }

  /** Process ids of live session shells. For tests and diagnostics. */
  sessionPids(): number[] {
    return [...this.sessions.values()].flatMap((session) => session.pid ?? []);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    clearInterval(this.sweeper);
    await Promise.all([...this.sessions.values()].map((session) => session.close()));
    this.sessions.clear();
    await this.runtime.stop();
  }

  private async handle(
    input: unknown,
    context: RequestContext,
  ): Promise<ExecResponse | CloseResult> {
    // `identity` is the caller's configured peer id. `from` is only where the
    // reply goes and must never decide access.
    if (!this.allowed.has(context.identity)) {
      this.runtime.logger.warn('refused shell request from a peer not in allowControllers', {
        identity: context.identity,
      });
      throw new DeadDropError(
        'UNAUTHORIZED',
        `peer "${context.identity}" is not in this agent's shell.allowControllers`,
      );
    }
    if (this.stopping) {
      throw new DeadDropError('UNSUPPORTED', 'shell agent is shutting down', { retryable: true });
    }
    const request = parseRequest(input);
    if (request.op === 'close') {
      const key = sessionKey(context.identity, request.sessionId);
      const session = this.sessions.get(key);
      this.sessions.delete(key);
      await session?.close();
      return { closed: session !== undefined };
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
    let session = this.sessions.get(key);
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
            'this shell session no longer exists on the agent (idle timeout, exit, or agent restart); the command was not run',
        };
      }
      session = new ShellSession({
        shell: this.options.shell.shell,
        cwd: this.home,
        env: this.env,
        outputCapBytes: this.options.shell.outputCapBytes,
        commandTimeoutMs: this.options.shell.commandTimeoutMs,
      });
      this.sessions.set(key, session);
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
    for (const [key, session] of this.sessions) {
      if (session.busy) continue;
      if (!session.closed && now - session.lastUsed < this.options.shell.idleTimeoutMs) continue;
      this.sessions.delete(key);
      this.runtime.logger.info('shell session closed after idle timeout', { pid: session.pid });
      await session.close();
    }
    await this.ledger.prune().catch((error: unknown) => {
      this.runtime.logger.warn('ledger prune failed', { error: String(error) });
    });
  }
}

function sessionKey(identity: string, sessionId: string): string {
  return `${identity}\0${sessionId}`;
}

function foreignJob(jobId: string): DeadDropError {
  return new DeadDropError('UNAUTHORIZED', `job ${jobId} belongs to another controller`);
}
