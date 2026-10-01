import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * What the audit log records. Never command text, output, or file paths: the
 * log says who did what kind of thing when, and how it went.
 */
export type AuditEvent =
  | { event: 'session-open' | 'session-close'; controller: string; sessionId: string }
  | { event: 'tty-open' | 'tty-close'; controller: string; ttyId: string }
  | {
      event: 'forward-open' | 'forward-close';
      controller: string;
      streamId: string;
      target: string;
    }
  | {
      event: 'exec';
      controller: string;
      jobId: string;
      sessionId: string;
      state: 'completed' | 'unknown' | 'session_lost';
      exitCode?: number | null;
      durationMs?: number;
      bytes?: number;
      truncated?: boolean;
      timedOut?: boolean;
      replayed?: boolean;
      cancelled?: boolean;
    }
  | { event: 'cancel'; controller: string; jobId: string }
  | { event: 'put' | 'get'; controller: string; transferId: string; bytes: number }
  | { event: 'refused'; controller: string; code: string; reason: string };

/**
 * One JSON line per event, appended to a file only the server's account can
 * read. Every line reopens the file, so `logrotate` can rename it underneath.
 * Writes are chained so lines land in order; a failed write is reported, never
 * thrown into the request that caused it.
 */
export class AuditLog {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string | false,
    private readonly onError: (error: unknown) => void,
  ) {}

  async open(): Promise<void> {
    if (this.path) await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
  }

  record(event: AuditEvent & { name?: string }): void {
    const path = this.path;
    if (!path) return;
    const line = `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`;
    this.tail = this.tail.then(() => appendFile(path, line, { mode: 0o600 })).catch(this.onError);
  }

  /** Resolves once every line recorded so far is written. */
  flush(): Promise<void> {
    return this.tail;
  }
}
