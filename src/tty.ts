import { chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { DeadDropError } from '@fyrlabs/dead-drop/protocol';
import type * as NodePty from 'node-pty';

import { OutputBuffer } from './output.js';

const HINT = 'node-pty is not built on this server (it needs python3, make and g++ to install)';

/** How long `close` waits for the shell to hang up before it kills it. */
const CLOSE_GRACE_MS = 1000;

let loaded: typeof NodePty | undefined;

/**
 * node-pty is an optional dependency: it compiles on Linux, so a server without
 * a compiler still runs line mode. Loading it here, once, keeps that failure
 * to one clear UNSUPPORTED answer instead of a crash at startup.
 */
export function loadPty(): typeof NodePty {
  if (loaded) return loaded;
  const require = createRequire(import.meta.url);
  try {
    // The 1.1.0 tarball ships its macOS spawn-helper without the execute bit,
    // and npm may skip the install script that would fix it.
    const root = join(dirname(require.resolve('node-pty')), '..');
    for (const helper of [
      join('prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      join('build', 'Release', 'spawn-helper'),
    ]) {
      try {
        chmodSync(join(root, helper), 0o755);
      } catch {
        // Absent on this platform, or not ours to change: spawn reports the rest.
      }
    }
    loaded = require('node-pty') as typeof NodePty;
    return loaded;
  } catch (error) {
    throw new DeadDropError('UNSUPPORTED', `terminal mode is unavailable: ${HINT}`, {
      cause: error,
    });
  }
}

export interface TtyOptions {
  shell: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  term: string;
  cols: number;
  rows: number;
  outputCapBytes: number;
}

export interface TtyExit {
  exitCode: number | null;
  signal: number | null;
}

/**
 * One shell on a pseudo-terminal. Its screen bytes land in an `OutputBuffer`
 * the client reads by offset, like a streamed job. Keystrokes are applied by
 * byte offset too, so a request delivered twice types nothing twice.
 */
export class TtySession {
  readonly buffer: OutputBuffer;
  readonly pid: number;
  exit: TtyExit | undefined;
  lastUsed = performance.now();
  /** Input bytes applied so far. */
  received = 0;
  private readonly pty: NodePty.IPty;
  private readonly exited: Promise<void>;

  constructor(options: TtyOptions) {
    this.buffer = new OutputBuffer(options.outputCapBytes);
    try {
      this.pty = loadPty().spawn(options.shell, ['-i'], {
        name: options.term,
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: options.env,
        encoding: null,
      });
    } catch (error) {
      if (error instanceof DeadDropError) throw error;
      throw new DeadDropError('UNSUPPORTED', `could not start a terminal: ${HINT}`, {
        cause: error,
      });
    }
    this.pid = this.pty.pid;
    this.pty.onData((data) => this.buffer.append(1, Buffer.from(data)));
    this.exited = new Promise((resolve) => {
      this.pty.onExit(({ exitCode, signal }) => {
        this.exit = { exitCode, signal: signal ?? null };
        this.buffer.close();
        resolve();
      });
    });
  }

  /**
   * Types `bytes`, which start at `offset` in the whole input stream. Bytes
   * already applied are skipped; a gap means the client lost track and is
   * refused rather than guessed at.
   */
  write(offset: number, bytes: Buffer): void {
    if (offset > this.received) {
      throw new DeadDropError(
        'BAD_REQUEST',
        `input starts at ${offset} but only ${this.received} bytes have arrived`,
      );
    }
    const fresh = bytes.subarray(this.received - offset);
    if (fresh.length === 0 || this.exit) return;
    this.received += fresh.length;
    this.pty.write(fresh);
  }

  resize(cols: number, rows: number): void {
    if (!this.exit) this.pty.resize(cols, rows);
  }

  async close(): Promise<void> {
    if (this.exit) return;
    this.pty.kill('SIGHUP');
    const timer = setTimeout(() => {
      try {
        process.kill(this.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }, CLOSE_GRACE_MS);
    await this.exited;
    clearTimeout(timer);
  }
}
