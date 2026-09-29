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
  /**
   * Base64, the whole file. A server that takes it (the file fits one chunk)
   * writes and commits in this one request and answers `committed`.
   */
  data?: string;
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
  /**
   * A file this size or smaller comes back whole in `data`, and the server
   * releases the transfer at once, so no chunk or close requests follow.
   */
  inline?: number;
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

/**
 * Creates a directory tree in one request: the root lands at `path` as a put
 * would (inside it, under `name`, when it is an existing directory), then every
 * entry of `dirs` beneath the root, parents first. Existing directories are kept,
 * as with `mkdir -p`.
 */
export interface MkdirRequest {
  v: 1;
  op: 'mkdir';
  path: string;
  name: string;
  mode: number;
  dirs: Array<{ path: string; mode: number }>;
}

export interface ListRequest {
  v: 1;
  op: 'list';
  path: string;
}

export type TransferRequest =
  | PutOpenRequest
  | PutChunkRequest
  | PutCommitRequest
  | GetOpenRequest
  | GetChunkRequest
  | TransferCloseRequest;

export type ShellRequest =
  ExecRequest | CloseRequest | PingRequest | TransferRequest | MkdirRequest | ListRequest;

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
  /** An inline put already landed. */
  committed?: boolean;
  /** Base64, the whole file of an inline get. */
  data?: string;
}

/** One entry below a listed directory. `path` is relative to it, `/`-separated. */
export interface TreeEntry {
  path: string;
  kind: 'dir' | 'file';
  mode: number;
  size: number;
}

export interface ListResult {
  /** Absolute path on the server. */
  path: string;
  kind: 'dir' | 'file';
  mode: number;
  size: number;
  /** Everything below a directory, parents before children. Empty for a file. */
  entries: TreeEntry[];
  /** What a copy leaves out: special files, broken links, loops, unreadable directories. */
  skipped: Array<{ path: string; reason: string }>;
}

export interface MkdirResult {
  /** The root's absolute path on the server. */
  path: string;
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
  TransferOpened | PutChunkResult | GetChunkResult | TransferCloseResult | ListResult | MkdirResult;

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
  if (source.op === 'list') return { v: 1, op: 'list', path: path(source.path, 'path') };
  if (source.op === 'mkdir') return parseMkdir(source);
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

/** Most entries a listing or a `mkdir` carries. */
export const MAX_TREE_ENTRIES = 100_000;

function name(value: unknown): string {
  const plain = path(value, 'name');
  if (plain.includes('/') || plain === '.' || plain === '..') bad('name must be a plain file name');
  return plain;
}

function mode(value: unknown): number {
  const bits = count(value, 'mode');
  if (bits > 0o777) bad('mode must be permission bits only');
  return bits;
}

function relative(value: unknown): string {
  const plain = path(value, 'dirs path');
  if (plain.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    bad('dirs paths must be relative, without empty, . or .. parts');
  }
  return plain;
}

function parseMkdir(source: Record<string, unknown>): MkdirRequest {
  if (!Array.isArray(source.dirs)) bad('dirs must be an array');
  if (source.dirs.length > MAX_TREE_ENTRIES) bad(`at most ${MAX_TREE_ENTRIES} dirs per request`);
  return {
    v: 1,
    op: 'mkdir',
    path: path(source.path, 'path'),
    name: name(source.name),
    mode: mode(source.mode),
    dirs: source.dirs.map((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) bad('dirs entries must be objects');
      const { path: dir, mode: bits } = entry as Record<string, unknown>;
      return { path: relative(dir), mode: mode(bits) };
    }),
  };
}

function parseTransfer(source: Record<string, unknown>): TransferRequest {
  if (!isJobId(source.transferId)) bad('transferId must be a UUID');
  const transferId = source.transferId;
  switch (source.op) {
    case 'put-open': {
      if (typeof source.sha256 !== 'string' || !SHA256.test(source.sha256)) {
        bad('sha256 must be 64 lowercase hex digits');
      }
      if (source.data !== undefined && typeof source.data !== 'string') bad('data must be base64');
      return {
        v: 1,
        op: 'put-open',
        transferId,
        path: path(source.path, 'path'),
        name: name(source.name),
        size: count(source.size, 'size'),
        sha256: source.sha256,
        mode: mode(source.mode),
        ...(source.data === undefined ? {} : { data: source.data }),
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
      return {
        v: 1,
        op: 'get-open',
        transferId,
        path: path(source.path, 'path'),
        ...(source.inline === undefined ? {} : { inline: count(source.inline, 'inline') }),
      };
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
