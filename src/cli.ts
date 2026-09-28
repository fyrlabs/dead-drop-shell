import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';

import { DeadDropError } from '@fyrlabs/dead-drop/protocol';

import { check } from './check.js';
import { ShellServer } from './server.js';
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  ShellClient,
  resolveTarget,
  type RemoteSession,
} from './client.js';
import { DEFAULT_CONFIG_PATH, loadConfig } from './config.js';
import type { ExecResponse } from './protocol.js';
import { VERSION } from './version.js';

export { VERSION };

const USAGE = `ddshell ${VERSION}: a line-oriented remote shell over dead-drop. Not SSH, no TTY.

Usage:
  ddshell serve [--config <file>]
  ddshell <target> [--config <file>] [--timeout <ms>] [--debug]
  ddshell exec <target>[,<target>...] [--config <file>] [--timeout <ms>] [--debug] -- <command...>
  ddshell ping <target>[,<target>...] [--config <file>] [--timeout <ms>] [--count <n>]
  ddshell check [--config <file>] [--debug]

Config: --config, else $DDSHELL_CONFIG, else ${DEFAULT_CONFIG_PATH}
Exit codes (exec): the remote exit code; 124 timed out on the target; 125 unknown
outcome after a server restart; 255 ddshell itself failed. With several targets,
each output line is prefixed with its target and the exit code is the highest.
Exit codes (ping): 0 every ping answered; 1 some did not; 255 ddshell failed.
Exit codes (check): 0 nothing failed (warnings allowed); 1 something failed.
`;

export interface Io {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
}

const defaultIo: Io = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
};

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  const note = (message: string) => io.stderr.write(`[ddshell] ${message}\n`);
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        timeout: { type: 'string' },
        count: { type: 'string' },
        debug: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (error) {
    note((error as Error).message);
    io.stderr.write(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    (values.help ? io.stdout : io.stderr).write(USAGE);
    return values.help ? 0 : 2;
  }
  const timeoutMs =
    values.timeout === undefined ? DEFAULT_COMMAND_TIMEOUT_MS : Number(values.timeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    note('--timeout must be a positive whole number of milliseconds');
    return 2;
  }
  const count = values.count === undefined ? 1 : Number(values.count);
  if (!Number.isInteger(count) || count <= 0) {
    note('--count must be a positive whole number');
    return 2;
  }
  const configPath = values.config ?? io.env.DDSHELL_CONFIG ?? DEFAULT_CONFIG_PATH;

  try {
    const [command, target, ...rest] = positionals;
    if (command === 'serve') {
      if (target !== undefined) throw usage('serve takes no positional arguments');
      return await serve(configPath);
    }
    if (command === 'check') {
      if (target !== undefined) throw usage('check takes no positional arguments');
      const findings = await check(configPath, values.debug);
      for (const { level, subject, message } of findings) {
        io.stdout.write(`${level.padEnd(4)}  ${subject}: ${message}\n`);
      }
      return findings.some((finding) => finding.level === 'fail') ? 1 : 0;
    }
    const config = await loadConfig(configPath);
    if (command === 'exec') {
      if (target === undefined || rest.length === 0) {
        throw usage('exec needs a target and a command after --');
      }
      return await exec(io, config, targets(target), rest.join(' '), timeoutMs, values.debug);
    }
    if (command === 'ping') {
      if (target === undefined) throw usage('ping needs a target');
      if (rest.length > 0) throw usage(`unexpected argument "${rest[0]}"`);
      return await ping(io, config, targets(target), { timeoutMs, count, debug: values.debug });
    }
    if (target !== undefined) throw usage(`unexpected argument "${target}"`);
    return await interactive(io, config, command!, timeoutMs, values.debug);
  } catch (error) {
    note(describe(error));
    return 255;
  }
}

/** `a,b,a` is `a` and `b`. */
function targets(list: string): string[] {
  const names = list.split(',');
  if (names.includes('')) throw usage(`empty target in "${list}"`);
  return [...new Set(names)];
}

function usage(message: string): DeadDropError {
  return new DeadDropError('BAD_REQUEST', `${message}\n\n${USAGE}`);
}

function describe(error: unknown): string {
  if (DeadDropError.is(error)) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

async function serve(configPath: string): Promise<number> {
  const config = await loadConfig(configPath);
  const running = await ShellServer.start({
    runtime: config.runtime,
    shell: config.shell,
    baseDir: config.baseDir,
  });
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await running.stop();
  return 0;
}

type Loaded = Awaited<ReturnType<typeof loadConfig>>;

async function exec(
  io: Io,
  config: Loaded,
  targets: string[],
  command: string,
  timeoutMs: number,
  debug: boolean,
): Promise<number> {
  const client = await ShellClient.start({ ...config, debug });
  try {
    return await fanOut(io, targets, (out, target) =>
      execOne(out, client, config, target, command, timeoutMs, debug),
    );
  } finally {
    await client.stop();
  }
}

/**
 * Runs `task` for every target at once and returns the highest exit code. One
 * target writes straight through. Several are each held back and printed as one
 * block when they finish, every line prefixed with the target's name.
 */
async function fanOut(
  io: Io,
  targets: string[],
  task: (io: Io, target: string) => Promise<number>,
): Promise<number> {
  if (targets.length === 1) return task(io, targets[0]!);
  const codes = await Promise.all(
    targets.map(async (target) => {
      const captured = capture(io);
      try {
        return await task(captured, target);
      } finally {
        captured.flush(`${target}: `);
      }
    }),
  );
  return Math.max(...codes);
}

async function ping(
  io: Io,
  config: Loaded,
  targets: string[],
  options: { timeoutMs: number; count: number; debug: boolean },
): Promise<number> {
  const client = await ShellClient.start({ ...config, debug: options.debug });
  try {
    return await fanOut(io, targets, (out, target) =>
      pingOne(out, client, resolveTarget(config.shell, target), options),
    );
  } finally {
    await client.stop();
  }
}

/** Pings one after another, like ping(8), so each round trip is measured alone. */
async function pingOne(
  io: Io,
  client: ShellClient,
  peer: string,
  options: { timeoutMs: number; count: number },
): Promise<number> {
  const times: number[] = [];
  for (let sent = 0; sent < options.count; sent += 1) {
    try {
      const { result, roundTripMs } = await client.ping(peer, { timeoutMs: options.timeoutMs });
      times.push(roundTripMs);
      const about = result
        ? `ddshell ${result.version}, dead-drop ${result.deadDropVersion}, up ${duration(result.uptimeMs)}`
        : 'an older ddshell without ping';
      io.stdout.write(`${about}, round trip ${roundTripMs} ms\n`);
    } catch (error) {
      const reason =
        DeadDropError.is(error) && error.code === 'TIMEOUT'
          ? `no answer within ${options.timeoutMs}ms`
          : describe(error);
      io.stderr.write(`[ddshell] ${reason}\n`);
    }
  }
  if (options.count > 1) {
    const sorted = [...times].sort((a, b) => a - b);
    const middle = sorted.length / 2;
    const median =
      sorted.length % 2 === 1
        ? sorted[Math.floor(middle)]!
        : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
    const spread =
      sorted.length === 0
        ? ''
        : `, round trip min ${sorted[0]} ms, median ${median} ms, max ${sorted.at(-1)} ms`;
    io.stdout.write(`${times.length}/${options.count} answered${spread}\n`);
  }
  return times.length === options.count ? 0 : 1;
}

function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (seconds < 60) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

async function execOne(
  io: Io,
  client: ShellClient,
  config: Loaded,
  target: string,
  command: string,
  timeoutMs: number,
  debug: boolean,
): Promise<number> {
  const session = client.session(resolveTarget(config.shell, target));
  const response = await send(io, session, command, { timeoutMs, debug, close: true });
  if (response === undefined) return 255;
  if (response.state === 'unknown') return 125;
  if (response.state === 'session_lost') return 255;
  if (response.timedOut) return 124;
  return response.exitCode ?? 255;
}

/** An `Io` that holds output back until `flush` writes it with every line prefixed. */
function capture(io: Io): Io & { flush(prefix: string): void } {
  const buffer = () => {
    const chunks: Buffer[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk);
        done();
      },
    });
    return { stream, text: () => Buffer.concat(chunks).toString() };
  };
  const stdout = buffer();
  const stderr = buffer();
  const prefixed = (text: string, prefix: string) =>
    text === ''
      ? ''
      : text
          .replace(/\n$/, '')
          .split('\n')
          .map((line) => `${prefix}${line}\n`)
          .join('');
  return {
    ...io,
    stdout: stdout.stream,
    stderr: stderr.stream,
    flush(prefix) {
      io.stdout.write(prefixed(stdout.text(), prefix));
      io.stderr.write(prefixed(stderr.text(), prefix));
    },
  };
}

async function interactive(
  io: Io,
  config: Loaded,
  target: string,
  timeoutMs: number,
  debug: boolean,
): Promise<number> {
  const peer = resolveTarget(config.shell, target);
  const client = await ShellClient.start({ ...config, debug });
  let session = client.session(peer);
  let cwd = '~';
  let waiting = false;
  let interrupts = 0;
  let currentAbort: AbortController | undefined;
  let abandonSession = false;
  let sessionEnded = false;
  const terminal = io.stdin.isTTY === true;

  const lines = createInterface({
    input: io.stdin,
    output: io.stdout,
    terminal,
  });
  // Like a shell, prompt only at a terminal, so piped scripts get clean output.
  // Readline also throws on a prompt after close, which piped input reaches
  // while commands are still in flight; the buffered lines still drain below.
  let inputClosed = io.stdin.isTTY !== true;
  lines.on('close', () => {
    inputClosed = true;
    // EOF at a terminal is an explicit request to leave. Piped input also
    // closes while buffered commands are still draining, so never abort it.
    if (terminal && waiting) {
      abandonSession = true;
      currentAbort?.abort();
    }
  });
  const prompt = () => {
    if (inputClosed) return;
    lines.setPrompt(`${target}:${cwd}$ `);
    lines.prompt();
  };
  lines.on('SIGINT', () => {
    if (!waiting) {
      io.stdout.write('\n');
      prompt();
      return;
    }
    interrupts += 1;
    if (interrupts > 1) {
      abandonSession = true;
      currentAbort?.abort();
      lines.close();
      return;
    }
    io.stderr.write(
      '\n[ddshell] phase one cannot cancel a remote command; it keeps running on the target. Press Ctrl-C again to leave.\n',
    );
  });

  let status = 0;
  prompt();
  try {
    for await (const line of lines) {
      if (line.trim() === '') {
        prompt();
        continue;
      }
      waiting = true;
      interrupts = 0;
      currentAbort = new AbortController();
      let response: ExecResponse | undefined;
      try {
        response = await send(io, session, line, {
          timeoutMs,
          debug,
          signal: currentAbort.signal,
        });
      } finally {
        currentAbort = undefined;
        waiting = false;
      }
      if (abandonSession) break;
      if (response?.state === 'session_lost') {
        session = client.session(peer);
        cwd = '~';
        io.stderr.write(
          '[ddshell] a new session will start in the home directory. Re-enter the command.\n',
        );
      } else if (response?.state === 'completed') {
        cwd = display(response.cwd, response.home);
        status = response.exitCode ?? status;
        if (response.sessionClosed) {
          sessionEnded = true;
          break;
        }
      }
      prompt();
    }
  } finally {
    lines.close();
    if (!abandonSession && !sessionEnded) await session.close().catch(() => undefined);
    await client.stop();
  }
  return status;
}

/** Runs one command and prints its output. `undefined` means no answer arrived. */
async function send(
  io: Io,
  session: RemoteSession,
  command: string,
  options: { timeoutMs: number; debug: boolean; close?: boolean; signal?: AbortSignal },
): Promise<ExecResponse | undefined> {
  const note = (message: string) => io.stderr.write(`[ddshell] ${message}\n`);
  const jobId = crypto.randomUUID();
  const started = performance.now();
  let response: ExecResponse;
  try {
    response = await session.exec(command, {
      jobId,
      timeoutMs: options.timeoutMs,
      ...(options.close ? { close: true } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (options.signal?.aborted && DeadDropError.is(error) && error.code === 'CANCELLED') {
      return undefined;
    }
    if (DeadDropError.is(error) && error.code === 'TIMEOUT') {
      note(
        `no answer within ${options.timeoutMs}ms. Job ${jobId} may still be running on the target, and later commands in this session wait behind it.`,
      );
    } else {
      note(describe(error));
    }
    return undefined;
  }

  if (response.state === 'session_lost') {
    note(response.message);
    return response;
  }
  if (response.state === 'unknown') {
    note(
      `job ${jobId} is UNKNOWN: the server restarted while it was running. It may have run fully, partly or not at all, and it will not be rerun.`,
    );
    return response;
  }
  io.stdout.write(Buffer.from(response.stdout, 'base64'));
  io.stderr.write(Buffer.from(response.stderr, 'base64'));
  if (response.truncated) note('output truncated at the server output cap');
  if (response.timedOut)
    note('command exceeded the server command timeout; its session was killed');
  else if (response.sessionClosed && !options.close) note('remote session closed');
  if (options.debug) {
    const roundTrip = Math.round(performance.now() - started);
    note(
      `job ${jobId} exit ${response.exitCode} server ${response.durationMs}ms round trip ${roundTrip}ms${response.replayed ? ' (replayed)' : ''}`,
    );
  }
  return response;
}

function display(cwd: string, home: string): string {
  if (cwd === home) return '~';
  if (cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
  return cwd;
}
