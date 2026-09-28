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
  /** Chosen by the client. Scoped to the caller's identity on the server. */
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

/** Asks whether the server is up and which versions it runs. Runs nothing. */
export interface PingRequest {
  v: 1;
  op: 'ping';
}

/**
 * Starts an upload. The server writes a temporary file beside `path` and only
 * renames it into place on `put-commit`, once size and sha256 match.
 */
export interface PutOpenRequest {
  v: 1;
  op: 'put-open';
  /** Chosen by the client. Scoped to the caller's identity on the server. */
  transferId: string;
  /** Relative paths resolve against the server account's home, like scp. `~/` is that home. */
  path: string;
  /** Appended to `path` when it names an existing directory. */
  name: string;
  size: number;
  /** Hex. */
  sha256: string;
  /** Permission bits for the new file. */
  mode: number;
}

export interface PutChunkRequest {
  v: 1;
  op: 'put-chunk';
  transferId: string;
  offset: number;
  /** Base64. At most the `chunkBytes` the server announced once decoded. */
  data: string;
}

export interface PutCommitRequest {
  v: 1;
  op: 'put-commit';
  transferId: string;
}

export interface GetOpenRequest {
  v: 1;
  op: 'get-open';
  transferId: string;
  path: string;
}

export interface GetChunkRequest {
  v: 1;
  op: 'get-chunk';
  transferId: string;
  offset: number;
  length: number;
}

/** Ends a transfer early or releases a finished download. A put that is not committed is discarded. */
export interface TransferCloseRequest {
  v: 1;
  op: 'transfer-close';
  transferId: string;
}

export type TransferRequest =
  | PutOpenRequest
  | PutChunkRequest
  | PutCommitRequest
  | GetOpenRequest
  | GetChunkRequest
  | TransferCloseRequest;

export type ShellRequest = ExecRequest | CloseRequest | PingRequest | TransferRequest;

export interface JobResult {
  jobId: string;
  /**
   * `unknown` means the server stopped while this job was running. It may have
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
  /** The server account's home, so a client can abbreviate `cwd` to `~`. */
  home: string;
  truncated: boolean;
  timedOut: boolean;
  sessionClosed: boolean;
  /** Answered from the ledger rather than executed by this request. */
  replayed: boolean;
}

/**
 * The session this command named no longer exists: it idled out, exited, or
 * the server restarted. The command was not run. Silently opening a fresh shell
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

export interface PingResult {
  /** ddshell on the server. */
  version: string;
  /** dead-drop on the server. */
  deadDropVersion: string;
  /** Milliseconds since `ddshell serve` started. */
  uptimeMs: number;
}

export interface TransferOpened {
  /** Absolute path on the server. */
  path: string;
  size: number;
  /** Hex. */
  sha256: string;
  mode: number;
  /** Largest chunk the server accepts or sends. */
  chunkBytes: number;
}

export interface PutChunkResult {
  written: number;
}

export interface GetChunkResult {
  /** Base64. */
  data: string;
}

export interface TransferCloseResult {
  closed: boolean;
}

export type TransferResponse =
  TransferOpened | PutChunkResult | GetChunkResult | TransferCloseResult;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Job and session ids become file names on the server, so only UUIDs are accepted. */
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
  if (source.op === 'ping') return { v: 1, op: 'ping' };
  if (typeof source.op === 'string' && TRANSFER_OPS.has(source.op)) return parseTransfer(source);
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

const TRANSFER_OPS = new Set([
  'put-open',
  'put-chunk',
  'put-commit',
  'get-open',
  'get-chunk',
  'transfer-close',
]);

const SHA256 = /^[0-9a-f]{64}$/;

function count(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) bad(`${name} must be a whole number`);
  return value as number;
}

function path(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') bad(`${name} must be a non-empty string`);
  if (value.includes('\0')) bad(`${name} must not contain NUL bytes`);
  return value;
}

function parseTransfer(source: Record<string, unknown>): TransferRequest {
  if (!isJobId(source.transferId)) bad('transferId must be a UUID');
  const transferId = source.transferId;
  switch (source.op) {
    case 'put-open': {
      const name = path(source.name, 'name');
      if (name.includes('/') || name === '.' || name === '..')
        bad('name must be a plain file name');
      if (typeof source.sha256 !== 'string' || !SHA256.test(source.sha256)) {
        bad('sha256 must be 64 lowercase hex digits');
      }
      const mode = count(source.mode, 'mode');
      if (mode > 0o777) bad('mode must be permission bits only');
      return {
        v: 1,
        op: 'put-open',
        transferId,
        path: path(source.path, 'path'),
        name,
        size: count(source.size, 'size'),
        sha256: source.sha256,
        mode,
      };
    }
    case 'put-chunk':
      if (typeof source.data !== 'string') bad('data must be base64');
      return {
        v: 1,
        op: 'put-chunk',
        transferId,
        offset: count(source.offset, 'offset'),
        data: source.data,
      };
    case 'get-open':
      return { v: 1, op: 'get-open', transferId, path: path(source.path, 'path') };
    case 'get-chunk':
      return {
        v: 1,
        op: 'get-chunk',
        transferId,
        offset: count(source.offset, 'offset'),
        length: count(source.length, 'length'),
      };
    default:
      return { v: 1, op: source.op as 'put-commit' | 'transfer-close', transferId };
  }
}
