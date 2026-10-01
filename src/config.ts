import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { DeadDropError } from '@fyrlabs/dead-drop/protocol';
import { parseRuntimeConfig, type RuntimeConfig } from '@fyrlabs/dead-drop/runtime';

import { parsePublicKey } from './keys.js';

export const DEFAULT_CONFIG_PATH = join(homedir(), '.deaddrop', 'ddshell.json');

export interface ShellConfig {
  /** Workspace carrying shell traffic. Defaults to the first one. */
  workspace?: string;
  /**
   * Server: public key lines (`ddshell-key <base64> [comment]`) of the
   * controllers allowed in over protocol v2.
   */
  authorizedKeys: string[];
  /**
   * Server: a file of more such lines, one per line, `#` comments allowed. Read
   * once at load and appended to `authorizedKeys`; a missing file adds none.
   */
  authorizedKeysFile?: string;
  /**
   * Server: also serve protocol v1, which trusts dead-drop peer ids. Any holder
   * of the workspace secret can claim any peer id, so this is off by default.
   */
  allowV1: boolean;
  /** Server: peer identities allowed in over protocol v1, when `allowV1` is on. */
  allowControllers: string[];
  /** Server: host key file, made on first start. */
  hostKey: string;
  /** Server: how far a request's timestamp may be from this clock. */
  replayWindowMs: number;
  /** Controller: key file made by `ddshell keygen`. Without it the controller speaks v1. */
  key: string;
  /** Controller: host keys pinned per server peer id. */
  knownHosts: string;
  /** Controller: refuse a server whose host key is not in `knownHosts` yet, instead of pinning it. */
  strictHostKeys: boolean;
  /** Server: POSIX shell each session runs. */
  shell: string;
  /** Server: stdout + stderr bytes kept per command. */
  outputCapBytes: number;
  /** Server: a session with no command for this long is closed. */
  idleTimeoutMs: number;
  /** Server: a command running longer than this kills its session. */
  commandTimeoutMs: number;
  /** Server: where job states are kept. */
  ledgerDir: string;
  /** Server: how long finished job records are kept for replay. */
  ledgerRetentionMs: number;
  /** Server: largest file `put` or `get` moves. */
  transferCapBytes: number;
  /** Server: largest piece of a file sent in one request. */
  transferChunkBytes: number;
  /** Server: live sessions one controller may hold at once. */
  maxSessions: number;
  /** Server: requests one controller may send per minute, in bursts of up to as many. */
  requestsPerMinute: number;
  /** Server: `host:port` pairs a controller may forward to. Empty refuses every forward. */
  allowForwards: string[];
  /** Server: JSON-lines audit file, or `false` for none. */
  auditLog: string | false;
  /** Controller: short target names mapped to server peer ids. */
  targets: Record<string, string>;
}

export interface LoadedConfig {
  runtime: RuntimeConfig;
  shell: ShellConfig;
  /** Directory relative paths in the file resolve against. */
  baseDir: string;
}

const MiB = 1024 * 1024;

/** Base64 of this stays well under dead-drop's 64 MiB message limit. */
export const MAX_TRANSFER_CHUNK_BYTES = 16 * MiB;

function fail(message: string): never {
  throw new DeadDropError('CONFIG_INVALID', message);
}

/** `~` is the home directory; anything relative resolves against `baseDir`. */
export function resolvePath(value: string, baseDir: string): string {
  if (value === '~' || value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  return resolve(baseDir, value);
}

function positive(source: Record<string, unknown>, key: string, fallback: number): number {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(`shell.${key} must be a positive number`);
  }
  return value;
}

/**
 * The `shell` section of a dead-drop runtime config. `parseRuntimeConfig`
 * ignores top-level keys it does not know, so one file serves both.
 */
export function parseShellConfig(
  raw: unknown,
  runtime: RuntimeConfig,
  baseDir: string,
): ShellConfig {
  const source = (raw ?? {}) as Record<string, unknown>;
  if (typeof source !== 'object' || Array.isArray(source)) fail('shell must be an object');

  if (source.workspace !== undefined) {
    const names = runtime.workspaces.map((workspace) => workspace.name);
    if (typeof source.workspace !== 'string' || !names.includes(source.workspace)) {
      fail(`shell.workspace must name a configured workspace (${names.join(', ')})`);
    }
  }
  const allow = source.allowControllers ?? [];
  if (!Array.isArray(allow) || !allow.every((peer) => typeof peer === 'string' && peer !== '')) {
    fail('shell.allowControllers must be an array of peer ids');
  }
  const authorizedKeys = source.authorizedKeys ?? [];
  if (!Array.isArray(authorizedKeys) || !authorizedKeys.every((line) => typeof line === 'string')) {
    fail('shell.authorizedKeys must be an array of public key lines');
  }
  authorizedKeys.forEach((line: string) => parsePublicKey(line));
  const forwards = source.allowForwards ?? [];
  if (!Array.isArray(forwards) || !forwards.every((entry) => typeof entry === 'string')) {
    fail('shell.allowForwards must be an array of "host:port" strings');
  }
  const allowForwards = forwards.map((entry: string) => {
    const parsed = parseForward(entry);
    if (!parsed) fail(`shell.allowForwards entry "${entry}" is not host:port`);
    return forwardKey(parsed.host, parsed.port);
  });
  for (const key of ['allowV1', 'strictHostKeys']) {
    if (source[key] !== undefined && typeof source[key] !== 'boolean')
      fail(`shell.${key} must be true or false`);
  }
  for (const key of ['authorizedKeysFile', 'hostKey', 'key', 'knownHosts']) {
    if (source[key] !== undefined && typeof source[key] !== 'string')
      fail(`shell.${key} must be a path`);
  }
  const file = (key: string, fallback: string) =>
    resolvePath(typeof source[key] === 'string' ? (source[key] as string) : fallback, baseDir);
  const targets = source.targets ?? {};
  if (
    typeof targets !== 'object' ||
    targets === null ||
    Array.isArray(targets) ||
    !Object.values(targets).every((peer) => typeof peer === 'string' && peer !== '')
  ) {
    fail('shell.targets must map target names to peer ids');
  }
  const shell = source.shell ?? '/bin/sh';
  if (typeof shell !== 'string' || !shell.startsWith('/')) {
    fail('shell.shell must be an absolute path to a POSIX shell');
  }
  if (source.ledgerDir !== undefined && typeof source.ledgerDir !== 'string') {
    fail('shell.ledgerDir must be a path');
  }
  if (
    source.auditLog !== undefined &&
    source.auditLog !== false &&
    (typeof source.auditLog !== 'string' || source.auditLog === '')
  ) {
    fail('shell.auditLog must be a path or false');
  }
  const maxSessions = positive(source, 'maxSessions', 16);
  if (!Number.isInteger(maxSessions)) fail('shell.maxSessions must be a whole number');

  const transferChunkBytes = positive(source, 'transferChunkBytes', 4 * MiB);
  if (!Number.isInteger(transferChunkBytes) || transferChunkBytes > MAX_TRANSFER_CHUNK_BYTES) {
    fail(
      `shell.transferChunkBytes must be a whole number no larger than ${MAX_TRANSFER_CHUNK_BYTES}`,
    );
  }

  return {
    ...(typeof source.workspace === 'string' ? { workspace: source.workspace } : {}),
    authorizedKeys: authorizedKeys as string[],
    ...(typeof source.authorizedKeysFile === 'string'
      ? { authorizedKeysFile: resolvePath(source.authorizedKeysFile, baseDir) }
      : {}),
    allowV1: source.allowV1 === true,
    allowControllers: allow as string[],
    hostKey: file('hostKey', 'ddshell_host_key'),
    replayWindowMs: positive(source, 'replayWindowMs', 10 * 60_000),
    key: file('key', 'ddshell_key'),
    knownHosts: file('knownHosts', 'ddshell_known_hosts'),
    strictHostKeys: source.strictHostKeys === true,
    shell,
    outputCapBytes: positive(source, 'outputCapBytes', 8 * MiB),
    idleTimeoutMs: positive(source, 'idleTimeoutMs', 30 * 60_000),
    commandTimeoutMs: positive(source, 'commandTimeoutMs', 10 * 60_000),
    ledgerDir:
      typeof source.ledgerDir === 'string'
        ? resolvePath(source.ledgerDir, baseDir)
        : join(runtime.dataDir, 'ddshell-ledger'),
    ledgerRetentionMs: positive(source, 'ledgerRetentionMs', 24 * 60 * 60_000),
    transferCapBytes: positive(source, 'transferCapBytes', 64 * MiB),
    transferChunkBytes,
    maxSessions,
    requestsPerMinute: positive(source, 'requestsPerMinute', 600),
    allowForwards,
    auditLog:
      source.auditLog === false
        ? false
        : typeof source.auditLog === 'string'
          ? resolvePath(source.auditLog, baseDir)
          : join(runtime.dataDir, 'ddshell-audit.log'),
    targets: targets as Record<string, string>,
  };
}

/** `host:port` or `[v6]:port`, port 1 to 65535. No wildcards: a forward is allowed by exact name. */
export function parseForward(spec: string): { host: string; port: number } | undefined {
  const match = /^(?:\[([0-9A-Fa-f:.]+)\]|([A-Za-z0-9._-]+)):(\d{1,5})$/.exec(spec);
  if (!match) return undefined;
  const port = Number(match[3]);
  if (port < 1 || port > 65535) return undefined;
  return { host: (match[1] ?? match[2])!, port };
}

/** What `allowForwards` holds and a request is compared with: host lowercased, no brackets. */
export function forwardKey(host: string, port: number): string {
  return `${host.toLowerCase()}:${port}`;
}

export async function loadConfig(path: string): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    throw new DeadDropError(
      'CONFIG_INVALID',
      `cannot read config file ${path}. Pass --config <file>; see docs/configuration.md.`,
      { cause },
    );
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch (cause) {
    throw new DeadDropError('CONFIG_INVALID', `config file ${path} is not valid JSON`, { cause });
  }
  const baseDir = dirname(resolve(path));
  const runtime = parseRuntimeConfig(raw, { baseDir });
  const shell = parseShellConfig(raw.shell, runtime, baseDir);
  if (shell.authorizedKeysFile) {
    shell.authorizedKeys = [
      ...shell.authorizedKeys,
      ...(await readAuthorizedKeys(shell.authorizedKeysFile)),
    ];
  }
  return { runtime, shell, baseDir };
}

async function readAuthorizedKeys(path: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new DeadDropError('CONFIG_INVALID', `cannot read ${path}`, { cause: error });
  }
  return text.split('\n').flatMap((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return [];
    try {
      parsePublicKey(trimmed);
    } catch (error) {
      fail(`${path} line ${index + 1}: ${(error as Error).message}`);
    }
    return [trimmed];
  });
}
