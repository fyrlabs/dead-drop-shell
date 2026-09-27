import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

import { DeadDropError } from '@fyrlabs/dead-drop/protocol';

import { ShellServer } from './server.js';
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  ShellClient,
  resolveTarget,
  type RemoteSession,
} from './client.js';
import { DEFAULT_CONFIG_PATH, loadConfig } from './config.js';
import type { ExecResponse } from './protocol.js';

export const VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

const USAGE = `ddshell ${VERSION}: a line-oriented remote shell over dead-drop. Not SSH, no TTY.

Usage:
  ddshell serve [--config <file>]
  ddshell <target> [--config <file>] [--timeout <ms>] [--debug]
  ddshell exec <target> [--config <file>] [--timeout <ms>] [--debug] -- <command...>

Config: --config, else $DDSHELL_CONFIG, else ${DEFAULT_CONFIG_PATH}
Exit codes (exec): the remote exit code; 124 timed out on the target; 125 unknown
outcome after a server restart; 255 ddshell itself failed.
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
  const configPath = values.config ?? io.env.DDSHELL_CONFIG ?? DEFAULT_CONFIG_PATH;

  try {
    const [command, target, ...rest] = positionals;
    if (command === 'serve') {
      if (target !== undefined) throw usage('serve takes no positional arguments');
      return await serve(configPath);
    }
    const config = await loadConfig(configPath);
    if (command === 'exec') {
      if (target === undefined || rest.length === 0) {
        throw usage('exec needs a target and a command after --');
      }
      return await exec(io, config, target, rest.join(' '), timeoutMs, values.debug);
    }
    if (target !== undefined) throw usage(`unexpected argument "${target}"`);
    return await interactive(io, config, command!, timeoutMs, values.debug);
  } catch (error) {
    note(describe(error));
    return 255;
  }
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
  target: string,
  command: string,
  timeoutMs: number,
  debug: boolean,
): Promise<number> {
  const client = await ShellClient.start({ ...config, debug });
  try {
    const session = client.session(resolveTarget(config.shell, target));
    const response = await send(io, session, command, { timeoutMs, debug, close: true });
    if (response === undefined) return 255;
    if (response.state === 'unknown') return 125;
    if (response.state === 'session_lost') return 255;
    if (response.timedOut) return 124;
    return response.exitCode ?? 255;
  } finally {
    await client.stop();
  }
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

  const lines = createInterface({
    input: io.stdin,
    output: io.stdout,
    terminal: io.stdin.isTTY === true,
  });
  // Like a shell, prompt only at a terminal, so piped scripts get clean output.
  // Readline also throws on a prompt after close, which piped input reaches
  // while commands are still in flight; the buffered lines still drain below.
  let inputClosed = io.stdin.isTTY !== true;
  lines.on('close', () => {
    inputClosed = true;
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
      const response = await send(io, session, line, { timeoutMs, debug });
      waiting = false;
      if (response?.state === 'session_lost') {
        session = client.session(peer);
        cwd = '~';
        io.stderr.write(
          '[ddshell] a new session will start in the home directory. Re-enter the command.\n',
        );
      } else if (response?.state === 'completed') {
        cwd = display(response.cwd, response.home);
        status = response.exitCode ?? status;
        if (response.sessionClosed) break;
      }
      prompt();
    }
  } finally {
    lines.close();
    await session.close().catch(() => undefined);
    await client.stop();
  }
  return status;
}

/** Runs one command and prints its output. `undefined` means no answer arrived. */
async function send(
  io: Io,
  session: RemoteSession,
  command: string,
  options: { timeoutMs: number; debug: boolean; close?: boolean },
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
    });
  } catch (error) {
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
