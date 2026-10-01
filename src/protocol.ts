import { createHash } from 'node:crypto';

import { DeadDropError } from '@fyrlabs/dead-drop/protocol';

/**
 * Registered as service `shell`, method `v1`, which dead-drop names channel
 * `shell.v1`. A breaking change to the shapes below gets `v2`, not a flag.
 */
export const SHELL_SERVICE = 'shell';
export const SHELL_METHOD = 'v1';
export const SHELL_CHANNEL = `${SHELL_SERVICE}.${SHELL_METHOD}`;
/**
 * The same operations, signed by the controller's key and sealed both ways.
 * See src/envelope.ts. The operation shapes below keep `v: 1` inside it.
 */
export const SHELL_CHANNEL_V2 = `${SHELL_SERVICE}.v2`;

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
  /** The session's name, recorded when `open` starts it, so `sessions` can show it. */
  name?: string;
  /**
   * Answer with a `JobOutput` as soon as the job runs and has output, instead
   * of holding the request until it finishes. An older server ignores this and
   * answers the `JobResult` as before.
   */
  stream?: boolean;
  /** How long a `stream` answer may wait for output or the end. The server caps it. */
  waitMs?: number;
}

/** A streamed job's output from `offset`, waiting up to `waitMs` for some. Runs nothing. */
export interface OutputRequest {
  v: 1;
  op: 'output';
  jobId: string;
  offset: number;
  waitMs?: number;
}

/**
 * Interrupts a running job: SIGINT to everything the command started. One
 * that ignores it is stopped with its session after a grace period. A job
 * still queued behind another in its session is not run.
 */
export interface CancelRequest {
  v: 1;
  op: 'cancel';
  jobId: string;
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

/** Lists the caller's own live sessions. Runs nothing. */
export interface SessionsRequest {
  v: 1;
  op: 'sessions';
}

/** Lists the caller's own jobs still in the server's ledger, newest first. Runs nothing. */
export interface JobsRequest {
  v: 1;
  op: 'jobs';
}

/** One of the caller's jobs from the ledger, without its output. Runs nothing. */
export interface JobRequest {
  v: 1;
  op: 'job';
  jobId: string;
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

/**
 * Starts a shell on a pseudo-terminal. Asking again with the same `ttyId`
 * returns the one already running, so a retried open starts nothing twice.
 * An older server answers BAD_REQUEST, which the client reports as unsupported.
 */
export interface TtyOpenRequest {
  v: 1;
  op: 'tty-open';
  /** Chosen by the client. Scoped to the caller's identity on the server. */
  ttyId: string;
  cols: number;
  rows: number;
  /** The client's `$TERM`. */
  term?: string;
}

/**
 * Types, resizes and reads the screen in one request. `input` starts at byte
 * `inputOffset` of everything the client has typed, and the server skips what
 * it already applied, so a delivered-twice request types nothing twice.
 * `offset` and `waitMs` work as in `OutputRequest`.
 */
export interface TtyIoRequest {
  v: 1;
  op: 'tty-io';
  ttyId: string;
  /** Base64. */
  input?: string;
  inputOffset: number;
  cols?: number;
  rows?: number;
  offset: number;
  waitMs?: number;
}

export interface TtyCloseRequest {
  v: 1;
  op: 'tty-close';
  ttyId: string;
}

export type TtyRequest = TtyOpenRequest | TtyIoRequest | TtyCloseRequest;

export type TransferRequest =
  | PutOpenRequest
  | PutChunkRequest
  | PutCommitRequest
  | GetOpenRequest
  | GetChunkRequest
  | TransferCloseRequest;

export type ShellRequest =
  | ExecRequest
  | OutputRequest
  | CancelRequest
  | CloseRequest
  | PingRequest
  | SessionsRequest
  | JobsRequest
  | JobRequest
  | TransferRequest
  | MkdirRequest
  | ListRequest
  | TtyRequest;

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
  /** A `cancel` reached it. `exitCode` is null if it never started or its session was killed. */
  cancelled?: boolean;
  /** Ledger only: a streamed job's output. Its `stdout` and `stderr` are empty. */
  output?: StoredOutput;
}

/** One piece of output. Base64. */
export interface OutputFrame {
  fd: 1 | 2;
  data: string;
}

export interface StoredOutput {
  /** Where the first kept byte sits in the job's combined output. */
  start: number;
  frames: OutputFrame[];
}

/**
 * Part of a streamed job's output. Offsets count stdout and stderr bytes
 * together, in the order the server read them.
 */
export interface JobOutput {
  jobId: string;
  state: 'running' | 'completed' | 'unknown';
  /** Where `frames` start. Larger than the offset asked for when older bytes were dropped. */
  offset: number;
  frames: OutputFrame[];
  /** Ask from here next. */
  next: number;
  /** Bytes produced so far. */
  end: number;
  /** Once the job is over and `next` reaches `end`. Its `stdout` and `stderr` are empty. */
  result?: JobResult;
}

export interface CancelResult {
  /** False when the job is not running here: already finished, or never seen. */
  cancelled: boolean;
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

export interface SessionInfo {
  sessionId: string;
  name?: string;
  pid?: number;
  cwd: string;
  /** Milliseconds since its last command finished; 0 while one is queued or running. */
  idleMs: number;
  busy: boolean;
}

export interface SessionsResult {
  /** The server account's home, so a client can abbreviate `cwd` to `~`. */
  home: string;
  sessions: SessionInfo[];
}

/** A job as the ledger knows it. Never the command, and no output. */
export interface JobInfo {
  jobId: string;
  sessionId: string;
  /** `running` here means the server has not finished it; `unknown` means it stopped mid-run. */
  state: 'running' | 'completed' | 'unknown';
  /** Milliseconds since the epoch, by the server's clock. */
  startedAt: number;
  finishedAt?: number;
  /** Null when it never started or its session was killed. Absent until finished. */
  exitCode?: number | null;
  durationMs?: number;
  cancelled?: boolean;
  truncated?: boolean;
  timedOut?: boolean;
}

export interface JobsResult {
  /** The server's clock now, so a client can show ages without trusting its own. */
  now: number;
  jobs: JobInfo[];
}

export interface JobStatus {
  now: number;
  job: JobInfo;
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

export interface TtyOpened {
  ttyId: string;
  /** The server account's home, so the client can show where the shell starts. */
  home: string;
}

/** Screen bytes from `offset`, as for `JobOutput`. All of them are on the terminal, so no `fd`. */
export interface TtyOutput {
  ttyId: string;
  state: 'running' | 'exited';
  offset: number;
  frames: OutputFrame[];
  next: number;
  end: number;
  /** Input bytes the server has applied. */
  received: number;
  /** Set once `state` is `exited`. */
  exit?: { exitCode: number | null; signal: number | null };
}

/** The terminal no longer exists: it idled out, was closed, or the server restarted. */
export interface TtyLost {
  ttyId: string;
  state: 'session_lost';
  message: string;
}

export interface TtyClosed {
  closed: boolean;
}

export type TtyResponse = TtyOpened | TtyOutput | TtyLost | TtyClosed;

/** Terminals are bounded so a bad size cannot make the server allocate without limit. */
export const MAX_TTY_DIMENSION = 1000;

const TERM = /^[A-Za-z0-9._-]{1,64}$/;

function dimension(value: unknown, name: string): number {
  const size = count(value, name);
  if (size < 1 || size > MAX_TTY_DIMENSION) bad(`${name} must be 1 to ${MAX_TTY_DIMENSION}`);
  return size;
}

function parseTty(source: Record<string, unknown>): TtyRequest {
  if (!isJobId(source.ttyId)) bad('ttyId must be a UUID');
  const ttyId = source.ttyId;
  if (source.op === 'tty-close') return { v: 1, op: 'tty-close', ttyId };
  if (source.op === 'tty-open') {
    if (source.term !== undefined && (typeof source.term !== 'string' || !TERM.test(source.term))) {
      bad('term must be 1 to 64 letters, digits, ".", "_" or "-"');
    }
    return {
      v: 1,
      op: 'tty-open',
      ttyId,
      cols: dimension(source.cols, 'cols'),
      rows: dimension(source.rows, 'rows'),
      ...(source.term === undefined ? {} : { term: source.term as string }),
    };
  }
  if (source.input !== undefined && typeof source.input !== 'string') bad('input must be base64');
  if ((source.cols === undefined) !== (source.rows === undefined)) {
    bad('cols and rows go together');
  }
  return {
    v: 1,
    op: 'tty-io',
    ttyId,
    inputOffset: count(source.inputOffset, 'inputOffset'),
    offset: count(source.offset, 'offset'),
    ...(source.input === undefined ? {} : { input: source.input }),
    ...(source.cols === undefined
      ? {}
      : { cols: dimension(source.cols, 'cols'), rows: dimension(source.rows, 'rows') }),
    ...(source.waitMs === undefined ? {} : { waitMs: count(source.waitMs, 'waitMs') }),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Job and session ids become file names on the server, so only UUIDs are accepted. */
export function isJobId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

const SESSION_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** Up to 64 letters, digits, `.`, `_` or `-`. */
export function isSessionName(value: unknown): value is string {
  return typeof value === 'string' && SESSION_NAME.test(value);
}

/**
 * The session id a name stands for. Every client derives the same one, so a
 * named session is found again by asking for it: an `open` for a live session
 * joins it, and for a missing one starts it. Ids are scoped to the caller's
 * identity on the server, so two controllers' sessions of one name stay apart.
 */
export function namedSessionId(name: string): string {
  const hex = createHash('sha256').update(`ddshell-session\0${name}`).digest('hex');
  // Shaped as an RFC 9562 version 8 (custom) UUID.
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function bad(message: string): never {
  throw new DeadDropError('BAD_REQUEST', message);
}

export function parseRequest(raw: unknown): ShellRequest {
  if (typeof raw !== 'object' || raw === null) bad('shell request must be an object');
  const source = raw as Record<string, unknown>;
  if (source.v !== 1) bad(`unsupported shell protocol version ${String(source.v)}`);
  if (source.op === 'ping') return { v: 1, op: 'ping' };
  if (source.op === 'sessions') return { v: 1, op: 'sessions' };
  if (source.op === 'jobs') return { v: 1, op: 'jobs' };
  if (source.op === 'job') {
    if (!isJobId(source.jobId)) bad('jobId must be a UUID');
    return { v: 1, op: 'job', jobId: source.jobId };
  }
  if (typeof source.op === 'string' && TRANSFER_OPS.has(source.op)) return parseTransfer(source);
  if (source.op === 'list') return { v: 1, op: 'list', path: path(source.path, 'path') };
  if (source.op === 'mkdir') return parseMkdir(source);
  if (source.op === 'tty-open' || source.op === 'tty-io' || source.op === 'tty-close') {
    return parseTty(source);
  }
  if (source.op === 'output' || source.op === 'cancel') {
    if (!isJobId(source.jobId)) bad('jobId must be a UUID');
    if (source.op === 'cancel') return { v: 1, op: 'cancel', jobId: source.jobId };
    return {
      v: 1,
      op: 'output',
      jobId: source.jobId,
      offset: count(source.offset, 'offset'),
      ...(source.waitMs === undefined ? {} : { waitMs: count(source.waitMs, 'waitMs') }),
    };
  }
  if (!isJobId(source.sessionId)) bad('sessionId must be a UUID');

  if (source.op === 'close') return { v: 1, op: 'close', sessionId: source.sessionId };
  if (source.op !== 'exec') bad(`unknown shell operation ${String(source.op)}`);
  if (!isJobId(source.jobId)) bad('jobId must be a UUID');
  if (typeof source.command !== 'string') bad('command must be a string');
  if (source.command.includes('\0')) bad('command must not contain NUL bytes');
  if (source.name !== undefined && !isSessionName(source.name)) {
    bad('name must be 1 to 64 letters, digits, ".", "_" or "-"');
  }
  return {
    v: 1,
    op: 'exec',
    sessionId: source.sessionId,
    jobId: source.jobId,
    command: source.command,
    ...(source.open === true ? { open: true } : {}),
    ...(source.close === true ? { close: true } : {}),
    ...(source.name === undefined ? {} : { name: source.name }),
    ...(source.stream === true ? { stream: true } : {}),
    ...(source.waitMs === undefined ? {} : { waitMs: count(source.waitMs, 'waitMs') }),
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
