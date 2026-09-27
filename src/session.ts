import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export interface SessionOptions {
  /** POSIX shell executable, e.g. `/bin/sh` or `/bin/bash`. */
  shell: string;
  /** Directory the shell starts in: the server account's home. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Combined stdout + stderr bytes kept per command. The rest is dropped. */
  outputCapBytes: number;
  /** A command running longer than this kills the whole session. */
  commandTimeoutMs: number;
}

export interface CommandResult {
  stdout: Buffer;
  stderr: Buffer;
  /** `null` when the command never reported one: killed, or the shell died. */
  exitCode: number | null;
  /** Working directory after the command, or the last known one. */
  cwd: string;
  truncated: boolean;
  timedOut: boolean;
  /** The shell is gone after this command (`exit`, timeout, crash). */
  sessionClosed: boolean;
  durationMs: number;
}

/**
 * Splits one output stream into the command's bytes and the trailer the
 * wrapper prints after it.
 *
 * The trailer is `\n<nonce>:<body>:<nonce>\n` with a fresh random nonce per
 * command, so output that merely looks like a trailer cannot end a command
 * early. The leading newline is ours, which is why it is stripped with the
 * trailer. The last `prefix.length - 1` bytes are held back because a prefix
 * can straddle two chunks.
 */
export class TrailerScanner {
  private pending = Buffer.alloc(0);
  private trailer: Buffer | undefined;
  body: string | undefined;

  constructor(
    private readonly prefix: Buffer,
    private readonly suffix: Buffer,
    private readonly commit: (bytes: Buffer) => void,
  ) {}

  /** Returns true once the trailer is complete. Bytes after it are dropped. */
  push(chunk: Buffer): boolean {
    if (this.body !== undefined) return true;
    if (this.trailer) {
      this.trailer = Buffer.concat([this.trailer, chunk]);
    } else {
      const buffer = Buffer.concat([this.pending, chunk]);
      const index = buffer.indexOf(this.prefix);
      if (index === -1) {
        const keep = Math.min(buffer.length, this.prefix.length - 1);
        this.commit(buffer.subarray(0, buffer.length - keep));
        this.pending = buffer.subarray(buffer.length - keep);
        return false;
      }
      this.commit(buffer.subarray(0, index));
      this.pending = Buffer.alloc(0);
      this.trailer = buffer.subarray(index + this.prefix.length);
    }
    const end = this.trailer.indexOf(this.suffix);
    if (end === -1) return false;
    this.body = this.trailer.subarray(0, end).toString('utf8');
    return true;
  }

  /** The shell died before printing a trailer: whatever was held back is output. */
  flush(): void {
    this.commit(this.pending);
    this.pending = Buffer.alloc(0);
  }
}

/** POSIX single-quoting. Safe for every byte except NUL, which is rejected upstream. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * One long-lived shell. Commands run one at a time through its stdin, so `cd`,
 * `export` and every other piece of shell state carries over to the next one.
 */
export class ShellSession {
  cwd: string;
  closed = false;
  lastUsed = performance.now();

  private readonly child: ChildProcessWithoutNullStreams;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private onExit: ((code: number | null) => void) | undefined;
  private exitCode: number | null = null;
  readonly exited: Promise<void>;

  constructor(private readonly options: SessionOptions) {
    this.cwd = options.cwd;
    // Detached puts the shell in its own process group, so closing the session
    // also kills whatever it started in the background.
    this.child = spawn(options.shell, [], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    // A write racing the shell's exit raises EPIPE; the exit handler reports it.
    this.child.stdin.on('error', () => undefined);
    this.exited = new Promise((resolve) => {
      const done = (code: number | null) => {
        if (this.closed) return;
        this.closed = true;
        this.exitCode = code;
        this.onExit?.(code);
        resolve();
      };
      this.child.on('exit', (code) => done(code));
      this.child.on('error', () => done(null));
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Runs `command`, queued behind any command already running in this session. */
  run(command: string): Promise<CommandResult> {
    this.pending += 1;
    const next = this.queue
      .then(() => this.execute(command))
      .finally(() => {
        this.pending -= 1;
        this.lastUsed = performance.now();
      });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** A command is queued or running. An idle sweep must leave this session alone. */
  get busy(): boolean {
    return this.pending > 0;
  }

  /** Kills the shell and everything in its process group. */
  async close(): Promise<void> {
    this.kill('SIGTERM');
    const timer = setTimeout(() => this.kill('SIGKILL'), 2000);
    await this.exited;
    clearTimeout(timer);
    // Background jobs outlive the shell's own exit; take the group down too.
    this.kill('SIGKILL');
  }

  private kill(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // Already gone.
    }
  }

  private async execute(command: string): Promise<CommandResult> {
    const started = performance.now();
    this.lastUsed = started;
    const result = (fields: Partial<CommandResult>): CommandResult => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: null,
      cwd: this.cwd,
      truncated: false,
      timedOut: false,
      sessionClosed: this.closed,
      durationMs: Math.round(performance.now() - started),
      ...fields,
    });

    if (this.closed) return result({ sessionClosed: true });

    // A syntax error inside `eval` makes a POSIX non-interactive shell exit, so
    // reject it before it can take the session down.
    const syntax = await checkSyntax(this.options.shell, command, this.options.env);
    if (syntax) return result({ exitCode: syntax.code, stderr: syntax.stderr });

    const nonce = randomBytes(16).toString('hex');
    const prefix = Buffer.from(`\n${nonce}:`);
    const suffix = Buffer.from(`:${nonce}\n`);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let kept = 0;
    let truncated = false;
    const keep = (target: Buffer[]) => (bytes: Buffer) => {
      if (bytes.length === 0) return;
      const room = this.options.outputCapBytes - kept;
      if (bytes.length > room) truncated = true;
      if (room <= 0) return;
      const slice = bytes.subarray(0, room);
      target.push(Buffer.from(slice));
      kept += slice.length;
    };
    const out = new TrailerScanner(prefix, suffix, keep(stdout));
    const err = new TrailerScanner(prefix, suffix, keep(stderr));

    let timer: NodeJS.Timeout | undefined;
    const outcome = await new Promise<'done' | 'exited' | 'timeout'>((resolve) => {
      const check = () => {
        if (out.body !== undefined && err.body !== undefined) resolve('done');
      };
      const onOut = (chunk: Buffer) => {
        out.push(chunk);
        check();
      };
      const onErr = (chunk: Buffer) => {
        err.push(chunk);
        check();
      };
      timer = setTimeout(() => resolve('timeout'), this.options.commandTimeoutMs);
      this.child.stdout.on('data', onOut);
      this.child.stderr.on('data', onErr);
      this.onExit = () => resolve('exited');
      // The command travels as a quoted variable and runs through `eval`, so an
      // unterminated quote or heredoc in it cannot swallow the trailer below.
      this.child.stdin.write(
        [
          `__ddshell_cmd=${shellQuote(command)}`,
          `eval "$__ddshell_cmd" </dev/null`,
          `__ddshell_status=$?`,
          `printf '\\n%s:%s:%s:%s\\n' ${nonce} "$__ddshell_status" "$PWD" ${nonce}`,
          `printf '\\n%s:end:%s\\n' ${nonce} ${nonce} >&2`,
          '',
        ].join('\n'),
      );
    }).finally(() => {
      clearTimeout(timer);
      this.onExit = undefined;
    });
    this.child.stdout.removeAllListeners('data');
    this.child.stderr.removeAllListeners('data');
    if (outcome !== 'done') {
      out.flush();
      err.flush();
    }

    if (outcome === 'timeout') {
      await this.close();
      return result({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        truncated,
        timedOut: true,
        sessionClosed: true,
      });
    }
    if (outcome === 'exited') {
      await this.close();
      return result({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode: this.exitCode,
        truncated,
        sessionClosed: true,
      });
    }

    const body = out.body ?? '';
    const separator = body.indexOf(':');
    const status = Number(body.slice(0, separator));
    this.cwd = body.slice(separator + 1);
    this.lastUsed = performance.now();
    return result({
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      exitCode: Number.isInteger(status) ? status : null,
      cwd: this.cwd,
      truncated,
    });
  }
}

function checkSyntax(
  shell: string,
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stderr: Buffer } | undefined> {
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-n', '-c', command],
      { env, encoding: 'buffer', timeout: 10_000 },
      (error, _stdout, stderr) => {
        if (!error) return resolve(undefined);
        const code = typeof error.code === 'number' ? error.code : 2;
        resolve({ code, stderr: Buffer.from(stderr) });
      },
    );
  });
}
