import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  type TreeCopy,
} from './client.js';
import { DEFAULT_CONFIG_PATH, loadConfig } from './config.js';
import { isSessionName, type ExecResponse, type TransferOpened } from './protocol.js';
import { VERSION } from './version.js';

export { VERSION };

const USAGE = `ddshell ${VERSION}: a line-oriented remote shell over dead-drop. Not SSH, no TTY.

Usage:
  ddshell serve [--config <file>]
  ddshell <target> [--session <name>] [--config <file>] [--timeout <ms>] [--debug]
  ddshell exec <target>[,<target>...] [--session <name>] [--config <file>] [--timeout <ms>] [--debug] -- <command...>
  ddshell sessions <target>[,<target>...] [--config <file>] [--timeout <ms>] [--debug]
  ddshell ping <target>[,<target>...] [--config <file>] [--timeout <ms>] [--count <n>]
  ddshell put [-r] <target>[,<target>...] <local-file> <remote-path> [--config <file>] [--timeout <ms>] [--debug]
  ddshell get [-r] <target> <remote-file> <local-path> [--config <file>] [--timeout <ms>] [--debug]
  ddshell cp [-r] [<target>:]<file> [<target>[,<target>...]:]<path> [--config <file>] [--timeout <ms>] [--debug]
  ddshell check [--config <file>] [--debug]

Config: --config, else $DDSHELL_CONFIG, else ${DEFAULT_CONFIG_PATH}
Exit codes (exec): the remote exit code; 124 timed out on the target; 125 unknown
outcome after a server restart; 255 ddshell itself failed. With several targets,
each output line is prefixed with its target and the exit code is the highest.
--session joins the live session of that name, or starts it, and leaves it
running on exit; it closes on \`exit\` or after the server's idle timeout.
Exit codes (ping, sessions): 0 every request answered; 1 some did not; 255 ddshell failed.
Exit codes (put, get, cp): 0 every copy landed and matched its sha256; 1 some did
not; 255 ddshell failed. Remote relative paths start in the target's home, as in scp.
-r copies directories, following symbolic links; a file that fails or is skipped
(special files, loops) is reported and makes the exit code 1.
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
        session: { type: 'string' },
        debug: { type: 'boolean', default: false },
        recursive: { type: 'boolean', short: 'r', default: false },
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
  if (values.session !== undefined && !isSessionName(values.session)) {
    note('--session must be 1 to 64 letters, digits, ".", "_" or "-"');
    return 2;
  }
  const configPath = values.config ?? io.env.DDSHELL_CONFIG ?? DEFAULT_CONFIG_PATH;

  try {
    const [command, target, ...rest] = positionals;
    const named = command === 'exec' || !COMMANDS.has(command!);
    if (values.session !== undefined && !named) {
      throw usage(`--session applies to an interactive session or exec, not ${command}`);
    }
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
      return await exec(io, config, targets(target), rest.join(' '), {
        timeoutMs,
        debug: values.debug,
        name: values.session,
      });
    }
    if (command === 'sessions') {
      if (target === undefined) throw usage('sessions needs a target');
      if (rest.length > 0) throw usage(`unexpected argument "${rest[0]}"`);
      return await sessions(io, config, targets(target), { timeoutMs, debug: values.debug });
    }
    if (command === 'ping') {
      if (target === undefined) throw usage('ping needs a target');
      if (rest.length > 0) throw usage(`unexpected argument "${rest[0]}"`);
      return await ping(io, config, targets(target), { timeoutMs, count, debug: values.debug });
    }
    if (command === 'put' || command === 'get') {
      const [from, to, extra] = rest;
      if (target === undefined || from === undefined || to === undefined) {
        throw usage(`${command} needs a target and two paths`);
      }
      if (extra !== undefined) throw usage(`unexpected argument "${extra}"`);
      const copy: Copy =
        command === 'put'
          ? { kind: 'put', targets: targets(target), local: from, remote: to }
          : { kind: 'get', target: single(target), remote: from, local: to };
      return await transfer(io, config, copy, {
        timeoutMs,
        debug: values.debug,
        recursive: values.recursive,
      });
    }
    if (command === 'cp') {
      const [to, extra] = rest;
      if (target === undefined || to === undefined)
        throw usage('cp needs a source and a destination');
      if (extra !== undefined) throw usage(`unexpected argument "${extra}"`);
      return await transfer(io, config, copyOf(target, to), {
        timeoutMs,
        debug: values.debug,
        recursive: values.recursive,
      });
    }
    if (target !== undefined) throw usage(`unexpected argument "${target}"`);
    return await interactive(io, config, command!, {
      timeoutMs,
      debug: values.debug,
      name: values.session,
    });
  } catch (error) {
    note(describe(error));
    return 255;
  }
}

/** A first word that is one of these is a subcommand, not a target. */
const COMMANDS = new Set(['serve', 'check', 'exec', 'sessions', 'ping', 'put', 'get', 'cp']);

/** `a,b,a` is `a` and `b`. */
function targets(list: string): string[] {
  const names = list.split(',');
  if (names.includes('')) throw usage(`empty target in "${list}"`);
  return [...new Set(names)];
}

function single(target: string): string {
  const [first, ...others] = targets(target);
  if (others.length > 0)
    throw usage('get takes one target: several would write the same local file');
  return first!;
}

type Copy =
  | { kind: 'put'; targets: string[]; local: string; remote: string }
  | { kind: 'get'; target: string; remote: string; local: string }
  | { kind: 'relay'; from: string; remote: string; targets: string[]; to: string };

/**
 * `vm:path` is remote, as in scp: a colon before any slash. `./a:b` is a local
 * file named `a:b`. `vm:` alone is the target's home directory.
 */
function remotePath(spec: string): { target: string; path: string } | undefined {
  const match = /^([^/:]+):(.*)$/s.exec(spec);
  if (!match) return undefined;
  return { target: match[1]!, path: match[2] === '' ? '.' : match[2]! };
}

function copyOf(source: string, destination: string): Copy {
  const from = remotePath(source);
  const to = remotePath(destination);
  if (from && to) {
    return {
      kind: 'relay',
      from: single(from.target),
      remote: from.path,
      targets: targets(to.target),
      to: to.path,
    };
  }
  if (from)
    return { kind: 'get', target: single(from.target), remote: from.path, local: destination };
  if (to) return { kind: 'put', targets: targets(to.target), local: source, remote: to.path };
  throw usage('cp needs <target>:<path> on at least one side');
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

interface SessionOptions {
  timeoutMs: number;
  debug: boolean;
  /** A named session is joined or started, and left running afterwards. */
  name: string | undefined;
}

async function exec(
  io: Io,
  config: Loaded,
  targets: string[],
  command: string,
  options: SessionOptions,
): Promise<number> {
  const client = await ShellClient.start({ ...config, debug: options.debug });
  try {
    return await fanOut(io, targets, (out, target) =>
      execOne(out, client, config, target, command, options),
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

async function sessions(
  io: Io,
  config: Loaded,
  targets: string[],
  options: { timeoutMs: number; debug: boolean },
): Promise<number> {
  const client = await ShellClient.start({ ...config, debug: options.debug });
  try {
    return await fanOut(io, targets, async (out, target) => {
      let listed;
      try {
        listed = await client.sessions(resolveTarget(config.shell, target), options);
      } catch (error) {
        out.stderr.write(`[ddshell] ${describe(error)}\n`);
        return 1;
      }
      const rows = listed.sessions.map((entry) => [
        entry.name ?? '-',
        entry.sessionId.slice(0, 8),
        entry.pid === undefined ? '-' : String(entry.pid),
        entry.busy ? 'busy' : `idle ${duration(entry.idleMs)}`,
        display(entry.cwd, listed.home),
      ]);
      const table = [['NAME', 'ID', 'PID', 'STATE', 'CWD'], ...rows];
      const widths = table[0]!.map((_, column) =>
        Math.max(...table.map((row) => row[column]!.length)),
      );
      for (const row of table) {
        out.stdout.write(
          `${row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!))).join('  ')}\n`,
        );
      }
      return 0;
    });
  } finally {
    await client.stop();
  }
}

async function transfer(
  io: Io,
  config: Loaded,
  copy: Copy,
  options: { timeoutMs: number; debug: boolean; recursive: boolean },
): Promise<number> {
  const client = await ShellClient.start({ ...config, debug: options.debug });
  const peer = (target: string) => resolveTarget(config.shell, target);
  const get = (target: string, remote: string, local: string, onProgress: Progress) =>
    options.recursive
      ? client.getTree(peer(target), remote, local, { timeoutMs: options.timeoutMs, onProgress })
      : client.get(peer(target), remote, local, { timeoutMs: options.timeoutMs, onProgress });
  const put = (target: string, local: string, remote: string, onProgress: Progress) =>
    options.recursive
      ? client.putTree(peer(target), local, remote, { timeoutMs: options.timeoutMs, onProgress })
      : client.put(peer(target), local, remote, { timeoutMs: options.timeoutMs, onProgress });
  try {
    if (copy.kind === 'get') {
      return await copyOne(io, options, `${copy.target}:${copy.remote}`, (onProgress) =>
        get(copy.target, copy.remote, copy.local, onProgress),
      );
    }
    let local = copy.kind === 'put' ? copy.local : '';
    let scratch: string | undefined;
    try {
      // Target to target goes through this machine, like `scp -3`.
      if (copy.kind === 'relay') {
        scratch = await mkdtemp(join(tmpdir(), 'ddshell-'));
        const fetched = await copyOne(
          io,
          options,
          `${copy.from}:${copy.remote}`,
          async (onProgress) => {
            const landed = await get(copy.from, copy.remote, `${scratch}/`, onProgress);
            local = landed.path;
            return landed;
          },
        );
        if (fetched !== 0) return fetched;
      }
      const remote = copy.kind === 'put' ? copy.remote : copy.to;
      return await fanOut(io, copy.targets, (out, target) =>
        copyOne(out, options, local, (onProgress) => put(target, local, remote, onProgress)),
      );
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  } finally {
    await client.stop();
  }
}

type Progress = (done: number, total: number) => void;

/**
 * Runs one copy, drawing progress at a terminal. 0 when everything landed
 * intact, 1 when not. A recursive copy reports each file it failed or skipped.
 */
async function copyOne(
  io: Io,
  options: { debug: boolean },
  source: string,
  run: (onProgress: Progress) => Promise<TransferOpened | TreeCopy>,
): Promise<number> {
  const note = (message: string) => io.stderr.write(`[ddshell] ${message}\n`);
  const terminal = (io.stderr as { isTTY?: boolean }).isTTY === true;
  const started = performance.now();
  const onProgress = (done: number, total: number) => {
    if (terminal) io.stderr.write(`\r[ddshell] ${source} ${size(done)} of ${size(total)}`);
  };
  try {
    const landed = await run(onProgress);
    if (terminal) io.stderr.write('\n');
    const elapsed = `${Math.round(performance.now() - started)}ms`;
    if (!('files' in landed)) {
      if (options.debug) {
        note(
          `${source} -> ${landed.path}, ${landed.size} bytes, sha256 ${landed.sha256}, ${elapsed}`,
        );
      }
      return 0;
    }
    for (const { path, reason } of landed.skipped) note(`${source}: skipped ${path}: ${reason}`);
    for (const { path, error } of landed.failed) note(`${source}: ${path}: ${describe(error)}`);
    if (options.debug) {
      note(`${source} -> ${landed.path}, ${landed.files} files, ${landed.bytes} bytes, ${elapsed}`);
    }
    return landed.failed.length + landed.skipped.length === 0 ? 0 : 1;
  } catch (error) {
    if (terminal) io.stderr.write('\n');
    note(`${source}: ${describe(error)}`);
    return 1;
  }
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
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
  { timeoutMs, debug, name }: SessionOptions,
): Promise<number> {
  const session = client.session(resolveTarget(config.shell, target), name);
  const response = await send(io, session, command, {
    timeoutMs,
    debug,
    ...(name === undefined ? { close: true } : {}),
  });
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
  { timeoutMs, debug, name }: SessionOptions,
): Promise<number> {
  const peer = resolveTarget(config.shell, target);
  const client = await ShellClient.start({ ...config, debug });
  let session = client.session(peer, name);
  // A named session may be joined wherever it was left; `?` until known.
  let cwd = name === undefined ? '~' : '?';
  let answered = false;
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
  const prompt = (redraw = false) => {
    if (inputClosed) return;
    lines.setPrompt(`${target}${name === undefined ? '' : `[${name}]`}:${cwd}$ `);
    lines.prompt(redraw);
  };
  if (name !== undefined) {
    // Not awaited: over GitHub a round trip takes seconds, and typing can start
    // at once. The prompt is redrawn if the answer comes before any command's.
    void client
      .sessions(peer, { timeoutMs })
      .then(({ sessions, home }) => {
        const live = sessions.find((listed) => listed.sessionId === session.id);
        if (answered) return;
        cwd = live ? display(live.cwd, home) : '~';
        if (terminal && !waiting) prompt(true);
      })
      .catch(() => undefined);
  }
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
      if (response !== undefined) answered = true;
      if (response?.state === 'session_lost') {
        session = client.session(peer, name);
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
    if (name !== undefined) {
      if (terminal && !sessionEnded) {
        io.stderr.write(`[ddshell] left session ${name} running on ${target}\n`);
      }
    } else if (!abandonSession && !sessionEnded) {
      await session.close().catch(() => undefined);
    }
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
