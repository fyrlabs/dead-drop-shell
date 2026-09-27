import { DeadDropError } from '@fyrlabs/dead-drop/protocol';

/** Request channel. A breaking change to the shapes below gets a new channel, not a flag. */
export const SHELL_CHANNEL = 'shell.v1';

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

export function parseRequest(payload: Uint8Array): ShellRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload).toString('utf8'));
  } catch {
    bad('shell request is not valid JSON');
  }
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
  };
}

export function encodeJson(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value));
}

export function decodeJson<T>(payload: Uint8Array): T {
  return JSON.parse(Buffer.from(payload).toString('utf8')) as T;
}
