import { DeadDropError } from '@fyrlabs/dead-drop/protocol';

/**
 * Registered as service `shell`, method `v1`, which dead-drop names channel
 * `shell.v1`. A breaking change to the shapes below gets `v2`, not a flag.
 */
export const SHELL_SERVICE = 'shell';
export const SHELL_METHOD = 'v1';
export const SHELL_CHANNEL = `${SHELL_SERVICE}.${SHELL_METHOD}`;

export interface ExecRequest {
  v: 1;
  op: 'exec';
  /** Chosen by the client. Scoped to the caller's identity on the agent. */
  sessionId: string;
  /** Chosen by the client, unique per command. The deduplication key. */
  jobId: string;
  command: string;
  /** Set on a session's first command. Without it an unknown session is an error, not a new shell. */
  open?: boolean;
  /** Close the session after this command. One round trip for a one-shot `exec`. */
  close?: boolean;
}

export interface CloseRequest {
  v: 1;
  op: 'close';
  sessionId: string;
}

export type ShellRequest = ExecRequest | CloseRequest;

export interface JobResult {
  jobId: string;
  /**
   * `unknown` means the agent stopped while this job was running. It may have
   * run fully, partly, or not at all, and it will not be run again.
   */
  state: 'completed' | 'unknown';
  /** Base64. */
  stdout: string;
  /** Base64. */
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  cwd: string;
  /** The agent account's home, so a client can abbreviate `cwd` to `~`. */
  home: string;
  truncated: boolean;
  timedOut: boolean;
  sessionClosed: boolean;
  /** Answered from the ledger rather than executed by this request. */
  replayed: boolean;
}

/**
 * The session this command named no longer exists: it idled out, exited, or
 * the agent restarted. The command was not run. Silently opening a fresh shell
 * in the home directory instead would run it somewhere the user did not `cd` to.
 */
export interface SessionLost {
  jobId: string;
  state: 'session_lost';
  message: string;
}

export type ExecResponse = JobResult | SessionLost;

export interface CloseResult {
  closed: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Job and session ids become file names on the agent, so only UUIDs are accepted. */
export function isJobId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function bad(message: string): never {
  throw new DeadDropError('BAD_REQUEST', message);
}

export function parseRequest(raw: unknown): ShellRequest {
  if (typeof raw !== 'object' || raw === null) bad('shell request must be an object');
  const source = raw as Record<string, unknown>;
  if (source.v !== 1) bad(`unsupported shell protocol version ${String(source.v)}`);
  if (!isJobId(source.sessionId)) bad('sessionId must be a UUID');

  if (source.op === 'close') return { v: 1, op: 'close', sessionId: source.sessionId };
  if (source.op !== 'exec') bad(`unknown shell operation ${String(source.op)}`);
  if (!isJobId(source.jobId)) bad('jobId must be a UUID');
  if (typeof source.command !== 'string') bad('command must be a string');
  if (source.command.includes('\0')) bad('command must not contain NUL bytes');
  return {
    v: 1,
    op: 'exec',
    sessionId: source.sessionId,
    jobId: source.jobId,
    command: source.command,
    ...(source.open === true ? { open: true } : {}),
    ...(source.close === true ? { close: true } : {}),
  };
}
