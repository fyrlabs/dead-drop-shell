import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { DeadDropError } from '@fyrlabs/dead-drop/protocol';
import { parseRuntimeConfig, type RuntimeConfig } from '@fyrlabs/dead-drop/runtime';

export const DEFAULT_CONFIG_PATH = join(homedir(), '.deaddrop', 'ddshell.json');

export interface ShellConfig {
  /** Workspace carrying shell traffic. Defaults to the first one. */
  workspace?: string;
  /** Server: peer identities allowed to run commands. Empty refuses everyone. */
  allowControllers: string[];
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

  const transferChunkBytes = positive(source, 'transferChunkBytes', 4 * MiB);
  if (!Number.isInteger(transferChunkBytes) || transferChunkBytes > MAX_TRANSFER_CHUNK_BYTES) {
    fail(
      `shell.transferChunkBytes must be a whole number no larger than ${MAX_TRANSFER_CHUNK_BYTES}`,
    );
  }

  return {
    ...(typeof source.workspace === 'string' ? { workspace: source.workspace } : {}),
    allowControllers: allow as string[],
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
    targets: targets as Record<string, string>,
  };
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
  return { runtime, shell: parseShellConfig(raw.shell, runtime, baseDir), baseDir };
}
