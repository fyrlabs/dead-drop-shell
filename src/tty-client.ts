import { setTimeout as sleep } from 'node:timers/promises';

import { DeadDropError } from '@fyrlabs/dead-drop/protocol';

import type { ShellCall } from './client.js';
import type {
  TtyCloseRequest,
  TtyIoRequest,
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
  /** Screen bytes, in order. */
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

/**
 * One terminal on a server. Typing and reading run as separate loops, so a key
 * never waits behind a long poll: the reader holds a request open for screen
 * output while the writer sends what was typed. Typed bytes are numbered, so
 * a request sent twice, or resent after a timeout, types nothing twice.
 */
export class RemoteTty {
  private unsent = Buffer.alloc(0);
  /** Typed bytes the server has confirmed. */
  private acked = 0;
  private size: TtySize | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly call: ShellCall,
    readonly peer: string,
    readonly id: string,
    readonly home: string,
  ) {}

  static async open(
    call: ShellCall,
    peer: string,
    id: string,
    size: TtySize,
    term: string | undefined,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<RemoteTty> {
    const request: TtyOpenRequest = { v: 1, op: 'tty-open', ttyId: id, ...size };
    if (term !== undefined) request.term = term;
    const { home } = await call<TtyOpened>(peer, request, options);
    return new RemoteTty(call, peer, id, home);
  }

  /** Queues keystrokes for the writer loop. */
  type(bytes: Buffer): void {
    this.unsent = Buffer.concat([this.unsent, bytes]);
    this.wake?.();
  }

  resize(size: TtySize): void {
    this.size = size;
    this.wake?.();
  }

  /**
   * Shows the screen and sends what is typed until the shell exits, `signal`
   * aborts (resolves undefined), or a request fails for good.
   */
  async attach(options: AttachOptions): Promise<TtyExit | undefined> {
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
    const request: TtyCloseRequest = { v: 1, op: 'tty-close', ttyId: this.id };
    await this.call(this.peer, request, { timeoutMs }).catch(() => undefined);
  }

  private async read({
    onOutput,
    onDropped,
    signal,
    timeoutMs,
  }: Required<Pick<AttachOptions, 'signal'>> & AttachOptions): Promise<TtyExit | undefined> {
    const waitMs = Math.min(POLL_WAIT_MS, Math.floor(timeoutMs / 2));
    let offset = 0;
    let failures = 0;
    while (!signal.aborted) {
      const request: TtyIoRequest = {
        v: 1,
        op: 'tty-io',
        ttyId: this.id,
        inputOffset: this.acked,
        offset,
        waitMs,
      };
      let answer: TtyOutput | TtyLost;
      try {
        answer = await this.call<TtyOutput | TtyLost>(this.peer, request, { timeoutMs, signal });
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
      if (answer.state === 'exited' && offset >= answer.end) {
        return answer.exit ?? { exitCode: null, signal: null };
      }
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
      const request: TtyIoRequest = {
        v: 1,
        op: 'tty-io',
        ttyId: this.id,
        inputOffset: this.acked,
        offset: PAST_THE_END,
        ...(input.length > 0 ? { input: input.toString('base64') } : {}),
        ...(size && size !== sentSize ? size : {}),
      };
      try {
        const answer = await this.call<TtyOutput | TtyLost>(this.peer, request, {
          timeoutMs,
          signal,
        });
        if (answer.state === 'session_lost') throw lost(answer);
        // Keys typed during the request stay queued for the next one.
        this.unsent = this.unsent.subarray(input.length);
        this.acked += input.length;
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

function lost({ message }: TtyLost): DeadDropError {
  return new DeadDropError('NOT_FOUND', message);
}
