import { setTimeout as sleep } from 'node:timers/promises';

import { DeadDropError } from '@fyrlabs/dead-drop/protocol';

import type { ShellCall } from './client.js';
import type {
  TcpLost,
  TcpOpenRequest,
  TcpOutput,
  TtyLost,
  TtyOpenRequest,
  TtyOpened,
  TtyOutput,
} from './protocol.js';

/** How long one answer may wait on the server for screen output. */
const POLL_WAIT_MS = 5000;

/** Keys typed within this long of each other travel in one request. */
const BATCH_MS = 50;

/** Failed requests in a row before giving up. Both kinds are safe to repeat. */
const ATTEMPTS = 10;

/** Queued bytes past this make `type` answer false, so a fast local sender can wait for a slow link. */
const HIGH_WATER = 1024 * 1024;

/** An offset no screen reaches, so a write's answer carries no output the reader will also fetch. */
const PAST_THE_END = Number.MAX_SAFE_INTEGER;

export interface TtySize {
  cols: number;
  rows: number;
}

export interface TtyExit {
  exitCode: number | null;
  signal: number | null;
}

export interface AttachOptions {
  /** Bytes from the far end, in order: the screen, or what a connection sent. */
  onOutput: (bytes: Buffer) => void;
  /** Called with how many bytes were skipped when the client fell further behind than the server keeps. */
  onDropped?: (bytes: number) => void;
  /** Detaches: the shell keeps running until the server's idle timeout. */
  signal?: AbortSignal;
  /** Per request, not for the whole terminal. */
  timeoutMs: number;
}

/** Errors a retry can cure. The server drops repeated input and only reads on a poll. */
export function transient(error: unknown): boolean {
  return (
    DeadDropError.is(error) &&
    (error.retryable || error.code === 'TIMEOUT' || error.code === 'RATE_LIMITED')
  );
}

/** What differs between a terminal and a TCP connection: the ops, and how one ends. */
interface Kind<End> {
  io: 'tty-io' | 'tcp-io';
  close: 'tty-close' | 'tcp-close';
  idField: 'ttyId' | 'streamId';
  /** The end of the stream once an answer says it is over. */
  end(answer: TtyOutput | TcpOutput): End | undefined;
}

type Answer = TtyOutput | TtyLost | TcpOutput | TcpLost;

const TTY: Kind<TtyExit> = {
  io: 'tty-io',
  close: 'tty-close',
  idField: 'ttyId',
  end: (answer) =>
    (answer as TtyOutput).state === 'exited'
      ? ((answer as TtyOutput).exit ?? { exitCode: null, signal: null })
      : undefined,
};

export interface TcpEnd {
  /** Why the connection ended, when it did not end cleanly. */
  error?: string;
}

const TCP: Kind<TcpEnd> = {
  io: 'tcp-io',
  close: 'tcp-close',
  idField: 'streamId',
  end: (answer) =>
    (answer as TcpOutput).state === 'closed'
      ? (answer as TcpOutput).error === undefined
        ? {}
        : { error: (answer as TcpOutput).error! }
      : undefined,
};

/**
 * One byte stream to a server: a terminal or a TCP connection. Sending and
 * reading run as separate loops, so a key never waits behind a long poll: the
 * reader holds a request open for output while the writer sends what was
 * typed. Sent bytes are numbered, so a request delivered twice, or resent
 * after a timeout, sends nothing twice.
 */
export class RemoteStream<End> {
  private unsent = Buffer.alloc(0);
  /** Typed bytes the server has confirmed. */
  private acked = 0;
  private size: TtySize | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly call: ShellCall,
    readonly peer: string,
    readonly id: string,
    private readonly kind: Kind<End>,
  ) {}

  /** Called once the queue has drained below the high-water mark after `type` answered false. */
  onDrain: (() => void) | undefined;

  /** Queues bytes for the writer loop. False means pause the source until `onDrain`. */
  type(bytes: Buffer): boolean {
    this.unsent = Buffer.concat([this.unsent, bytes]);
    this.wake?.();
    return this.unsent.length < HIGH_WATER;
  }

  resize(size: TtySize): void {
    this.size = size;
    this.wake?.();
  }

  /**
   * Shows the screen and sends what is typed until the shell exits, `signal`
   * aborts (resolves undefined), or a request fails for good.
   */
  async attach(options: AttachOptions): Promise<End | undefined> {
    const stop = new AbortController();
    const forward = () => stop.abort();
    options.signal?.addEventListener('abort', forward, { once: true });
    if (options.signal?.aborted) stop.abort();
    const inner = { ...options, signal: stop.signal };
    try {
      const [exit] = await Promise.all([
        this.read(inner).finally(() => stop.abort()),
        this.write(inner).finally(() => stop.abort()),
      ]);
      return exit;
    } finally {
      options.signal?.removeEventListener('abort', forward);
    }
  }

  /** Releases the server's shell. Best effort: an idle timeout ends it anyway. */
  async close(timeoutMs = 10_000): Promise<void> {
    const request = { v: 1, op: this.kind.close, [this.kind.idField]: this.id };
    await this.call(this.peer, request as never, { timeoutMs }).catch(() => undefined);
  }

  private async read({
    onOutput,
    onDropped,
    signal,
    timeoutMs,
  }: Required<Pick<AttachOptions, 'signal'>> & AttachOptions): Promise<End | undefined> {
    const waitMs = Math.min(POLL_WAIT_MS, Math.floor(timeoutMs / 2));
    let offset = 0;
    let failures = 0;
    while (!signal.aborted) {
      const request = {
        v: 1,
        op: this.kind.io,
        [this.kind.idField]: this.id,
        inputOffset: this.acked,
        offset,
        waitMs,
      };
      let answer: Answer;
      try {
        answer = await this.call<Answer>(this.peer, request as never, { timeoutMs, signal });
        failures = 0;
      } catch (error) {
        if (signal.aborted) return undefined;
        failures = await this.retry(error, failures);
        continue;
      }
      if (answer.state === 'session_lost') throw lost(answer);
      if (answer.offset > offset) onDropped?.(answer.offset - offset);
      for (const { data } of answer.frames) onOutput(Buffer.from(data, 'base64'));
      offset = answer.next;
      const end = this.kind.end(answer);
      if (end !== undefined && offset >= answer.end) return end;
    }
    return undefined;
  }

  private async write({
    signal,
    timeoutMs,
  }: Required<Pick<AttachOptions, 'signal'>> & AttachOptions): Promise<undefined> {
    let sentSize: TtySize | undefined;
    let failures = 0;
    signal.addEventListener('abort', () => this.wake?.(), { once: true });
    while (!signal.aborted) {
      while (!signal.aborted && this.unsent.length === 0 && this.size === sentSize) {
        await new Promise<void>((resolve) => (this.wake = resolve));
      }
      this.wake = undefined;
      if (signal.aborted) return undefined;
      // Let the rest of a burst, a paste or a held key, join this request.
      await sleep(BATCH_MS, undefined, { signal }).catch(() => undefined);
      const input = this.unsent;
      const size = this.size;
      const request = {
        v: 1,
        op: this.kind.io,
        [this.kind.idField]: this.id,
        inputOffset: this.acked,
        offset: PAST_THE_END,
        ...(input.length > 0 ? { input: input.toString('base64') } : {}),
        ...(size && size !== sentSize ? size : {}),
      };
      try {
        const answer = await this.call<Answer>(this.peer, request as never, {
          timeoutMs,
          signal,
        });
        if (answer.state === 'session_lost') throw lost(answer);
        // Keys typed during the request stay queued for the next one.
        this.unsent = this.unsent.subarray(input.length);
        this.acked += input.length;
        if (this.unsent.length < HIGH_WATER) this.onDrain?.();
        sentSize = size;
        failures = 0;
      } catch (error) {
        if (signal.aborted) return undefined;
        failures = await this.retry(error, failures);
      }
    }
    return undefined;
  }

  private async retry(error: unknown, failures: number): Promise<number> {
    if (!transient(error) || failures + 1 >= ATTEMPTS) throw error;
    await sleep(1000 * (failures + 1));
    return failures + 1;
  }
}

export type RemoteTty = RemoteStream<TtyExit>;

export async function openTty(
  call: ShellCall,
  peer: string,
  id: string,
  size: TtySize,
  term: string | undefined,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<RemoteTty> {
  const request: TtyOpenRequest = { v: 1, op: 'tty-open', ttyId: id, ...size };
  if (term !== undefined) request.term = term;
  await call<TtyOpened>(peer, request, options);
  return new RemoteStream(call, peer, id, TTY);
}

/** Opens a TCP connection from the server to `host:port`, which its `allowForwards` must list. */
export async function openTcp(
  call: ShellCall,
  peer: string,
  id: string,
  target: { host: string; port: number },
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<RemoteStream<TcpEnd>> {
  const request: TcpOpenRequest = { v: 1, op: 'tcp-open', streamId: id, ...target };
  await call(peer, request, options);
  return new RemoteStream(call, peer, id, TCP);
}

function lost({ message }: TtyLost | TcpLost): DeadDropError {
  return new DeadDropError('NOT_FOUND', message);
}
