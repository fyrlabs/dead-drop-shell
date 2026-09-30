import type { OutputFrame, StoredOutput } from './protocol.js';

/** Most output bytes one `output` answer carries. The client asks again for the rest. */
export const OUTPUT_REPLY_BYTES = 1024 * 1024;

interface Frame {
  fd: 1 | 2;
  /** Position of the first byte in the job's combined stdout and stderr. */
  offset: number;
  bytes: Buffer;
}

export interface OutputSlice {
  /** Where the first returned byte sits. Larger than asked when older bytes were dropped. */
  offset: number;
  frames: OutputFrame[];
  next: number;
  end: number;
}

/**
 * A running job's output, stdout and stderr in the order they arrived. Only
 * the latest `capBytes` are kept: a client that falls further behind than that
 * is told how much it missed rather than holding the server's memory hostage.
 */
export class OutputBuffer {
  private frames: Frame[] = [];
  private start = 0;
  end = 0;
  private waiters = new Set<() => void>();
  private closed = false;

  constructor(private readonly capBytes: number) {}

  append(fd: 1 | 2, bytes: Buffer): void {
    if (bytes.length === 0) return;
    this.frames.push({ fd, offset: this.end, bytes });
    this.end += bytes.length;
    while (this.end - this.start > this.capBytes) {
      const first = this.frames[0]!;
      const excess = this.end - this.start - this.capBytes;
      if (first.bytes.length <= excess) {
        this.frames.shift();
        this.start += first.bytes.length;
      } else {
        first.bytes = first.bytes.subarray(excess);
        first.offset += excess;
        this.start += excess;
      }
    }
    this.wake();
  }

  read(offset: number, maxBytes = OUTPUT_REPLY_BYTES): OutputSlice {
    return slice(this.frames, this.start, this.end, offset, maxBytes);
  }

  /** Resolves once there are bytes past `offset`, the buffer closes, or `ms` pass. */
  waitFor(offset: number, ms: number): Promise<void> {
    if (this.closed || this.end > offset || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  /** The job finished: wake every waiter now. */
  close(): void {
    this.closed = true;
    this.wake();
  }

  /** What the ledger keeps once the job completes. */
  snapshot(): StoredOutput {
    return { start: this.start, frames: this.read(this.start, Infinity).frames };
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}

/** Reads a completed job's output back out of its ledger record. */
export function readStored(
  stored: StoredOutput,
  offset: number,
  maxBytes = OUTPUT_REPLY_BYTES,
): OutputSlice {
  let position = stored.start;
  const frames = stored.frames.map(({ fd, data }) => {
    const bytes = Buffer.from(data, 'base64');
    const frame = { fd, offset: position, bytes };
    position += bytes.length;
    return frame;
  });
  return slice(frames, stored.start, position, offset, maxBytes);
}

function slice(
  frames: Frame[],
  start: number,
  end: number,
  offset: number,
  maxBytes: number,
): OutputSlice {
  const from = Math.min(Math.max(offset, start), end);
  const limit = Math.min(end, from + maxBytes);
  const out: Array<{ fd: 1 | 2; bytes: Buffer[] }> = [];
  for (const frame of frames) {
    const frameEnd = frame.offset + frame.bytes.length;
    if (frameEnd <= from) continue;
    if (frame.offset >= limit) break;
    const bytes = frame.bytes.subarray(
      Math.max(0, from - frame.offset),
      Math.min(frame.bytes.length, limit - frame.offset),
    );
    // Adjacent pieces from one stream travel as one frame.
    const last = out.at(-1);
    if (last?.fd === frame.fd) last.bytes.push(bytes);
    else out.push({ fd: frame.fd, bytes: [bytes] });
  }
  return {
    offset: from,
    frames: out.map(({ fd, bytes }) => ({ fd, data: Buffer.concat(bytes).toString('base64') })),
    next: limit,
    end,
  };
}
