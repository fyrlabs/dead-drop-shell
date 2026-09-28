import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateWorkspaceSecret } from '@fyrlabs/dead-drop/protocol';
import { parseRuntimeConfig } from '@fyrlabs/dead-drop/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, parseShellConfig } from '../src/config.js';

const examples = fileURLToPath(new URL('../examples/', import.meta.url));
let home: string;
let savedHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ddshell-config-'));
  savedHome = process.env.HOME;
  process.env.HOME = home;
  await mkdir(join(home, '.deaddrop'));
  await writeFile(join(home, '.deaddrop', 'ddshell.secret'), `${generateWorkspaceSecret()}\n`);
});

afterEach(async () => {
  process.env.HOME = savedHome;
  await rm(home, { recursive: true, force: true });
});

const runtime = () =>
  parseRuntimeConfig({
    dataDir: '/var/lib/ddshell',
    workspaces: [
      {
        name: 'w',
        peerId: 'p',
        secrets: [generateWorkspaceSecret()],
        transports: [{ use: 'memory' }],
      },
    ],
  });

describe('config', () => {
  it('loads the shipped examples', async () => {
    const server = await loadConfig(join(examples, 'server.json'));
    expect(server.shell).toMatchObject({
      allowControllers: ['laptop'],
      shell: '/bin/bash',
      outputCapBytes: 8 * 1024 * 1024,
      ledgerDir: join(home, '.deaddrop', 'ddshell-ledger'),
    });
    const controller = await loadConfig(join(examples, 'controller.json'));
    expect(controller.shell.targets).toEqual({ vm: 'vm' });
    expect(controller.shell.allowControllers).toEqual([]);
    const demo = join(home, 'demo');
    await cp(join(examples, 'local'), demo, { recursive: true });
    await writeFile(join(demo, 'secret'), `${generateWorkspaceSecret()}\n`);
    const local = await loadConfig(join(demo, 'server.json'));
    expect(local.shell.ledgerDir).toBe(join(demo, 'server-state', 'ddshell-ledger'));
    expect((await loadConfig(join(demo, 'controller.json'))).shell.targets).toEqual({ vm: 'vm' });
  });

  it('applies defaults', () => {
    expect(parseShellConfig(undefined, runtime(), '/etc')).toEqual({
      allowControllers: [],
      shell: '/bin/sh',
      outputCapBytes: 8 * 1024 * 1024,
      idleTimeoutMs: 30 * 60_000,
      commandTimeoutMs: 10 * 60_000,
      ledgerDir: '/var/lib/ddshell/ddshell-ledger',
      ledgerRetentionMs: 24 * 60 * 60_000,
      transferCapBytes: 64 * 1024 * 1024,
      transferChunkBytes: 4 * 1024 * 1024,
      targets: {},
    });
  });

  it.each([
    [{ allowControllers: 'laptop' }, /allowControllers/],
    [{ shell: 'bash' }, /absolute path/],
    [{ outputCapBytes: 0 }, /outputCapBytes/],
    [{ targets: { vm: 3 } }, /targets/],
    [{ transferChunkBytes: 32 * 1024 * 1024 }, /transferChunkBytes/],
    [{ transferChunkBytes: 1.5 }, /transferChunkBytes/],
    [{ transferCapBytes: -1 }, /transferCapBytes/],
    [{ workspace: 'other' }, /configured workspace/],
  ])('rejects %j', (shell, message) => {
    expect(() => parseShellConfig(shell, runtime(), '/etc')).toThrow(message);
  });

  it('resolves a relative ledger directory against the config file', () => {
    expect(parseShellConfig({ ledgerDir: 'ledger' }, runtime(), '/etc/ddshell').ledgerDir).toBe(
      '/etc/ddshell/ledger',
    );
  });
});
