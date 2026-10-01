import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateWorkspaceSecret } from '@fyrlabs/dead-drop/protocol';
import { parseRuntimeConfig } from '@fyrlabs/dead-drop/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, parseShellConfig } from '../src/config.js';
import { formatPublicKey, generateKeyPair } from '../src/keys.js';

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
    const deaddrop = join(home, '.deaddrop');
    const server = await loadConfig(join(examples, 'server.json'));
    expect(server.shell).toMatchObject({
      authorizedKeys: [],
      authorizedKeysFile: join(deaddrop, 'ddshell_authorized_keys'),
      allowControllers: [],
      hostKey: join(deaddrop, 'ddshell_host_key'),
      shell: '/bin/bash',
      outputCapBytes: 8 * 1024 * 1024,
      ledgerDir: join(deaddrop, 'ddshell-ledger'),
    });
    const line = formatPublicKey(generateKeyPair(), 'laptop');
    await writeFile(join(deaddrop, 'ddshell_authorized_keys'), `# controllers\n${line}\n\n`);
    expect((await loadConfig(join(examples, 'server.json'))).shell.authorizedKeys).toEqual([line]);
    const controller = await loadConfig(join(examples, 'controller.json'));
    expect(controller.shell).toMatchObject({
      targets: { vm: 'vm' },
      key: join(deaddrop, 'ddshell_key'),
      knownHosts: join(deaddrop, 'ddshell_known_hosts'),
    });
    const demo = join(home, 'demo');
    await cp(join(examples, 'local'), demo, { recursive: true });
    await writeFile(join(demo, 'secret'), `${generateWorkspaceSecret()}\n`);
    await writeFile(join(demo, 'authorized_keys'), `${line}\n`);
    const local = await loadConfig(join(demo, 'server.json'));
    expect(local.shell).toMatchObject({
      authorizedKeys: [line],
      hostKey: join(demo, 'server-state', 'host_key'),
      ledgerDir: join(demo, 'server-state', 'ddshell-ledger'),
    });
    expect((await loadConfig(join(demo, 'controller.json'))).shell).toMatchObject({
      targets: { vm: 'vm' },
      key: join(demo, 'controller_key'),
      knownHosts: join(demo, 'known_hosts'),
    });
  });

  it('names the bad line of an authorized keys file', async () => {
    const path = join(home, 'config.json');
    await writeFile(
      path,
      JSON.stringify({
        workspaces: [
          {
            name: 'w',
            peerId: 'p',
            secrets: [generateWorkspaceSecret()],
            transports: [{ use: 'memory' }],
          },
        ],
        shell: { authorizedKeysFile: 'keys' },
      }),
    );
    await writeFile(
      join(home, 'keys'),
      `# ok\n${formatPublicKey(generateKeyPair())}\nssh-ed25519 AAAA\n`,
    );
    await expect(loadConfig(path)).rejects.toThrow(/keys line 3: not a ddshell public key/);
  });

  it('applies defaults', () => {
    expect(parseShellConfig(undefined, runtime(), '/etc')).toEqual({
      authorizedKeys: [],
      allowV1: false,
      allowControllers: [],
      hostKey: '/etc/ddshell_host_key',
      replayWindowMs: 10 * 60_000,
      key: '/etc/ddshell_key',
      knownHosts: '/etc/ddshell_known_hosts',
      strictHostKeys: false,
      shell: '/bin/sh',
      outputCapBytes: 8 * 1024 * 1024,
      idleTimeoutMs: 30 * 60_000,
      commandTimeoutMs: 10 * 60_000,
      ledgerDir: '/var/lib/ddshell/ddshell-ledger',
      ledgerRetentionMs: 24 * 60 * 60_000,
      transferCapBytes: 64 * 1024 * 1024,
      transferChunkBytes: 4 * 1024 * 1024,
      maxSessions: 16,
      requestsPerMinute: 600,
      allowForwards: [],
      auditLog: '/var/lib/ddshell/ddshell-audit.log',
      targets: {},
    });
  });

  it('turns the audit log off with false and resolves a relative path', () => {
    expect(parseShellConfig({ auditLog: false }, runtime(), '/etc').auditLog).toBe(false);
    expect(parseShellConfig({ auditLog: 'audit.log' }, runtime(), '/etc/ddshell').auditLog).toBe(
      '/etc/ddshell/audit.log',
    );
  });

  it.each([
    [{ allowControllers: 'laptop' }, /allowControllers/],
    [{ authorizedKeys: 'ddshell-key x' }, /authorizedKeys/],
    [{ authorizedKeys: ['ssh-ed25519 AAAA'] }, /key/],
    [{ allowV1: 'yes' }, /allowV1/],
    [{ strictHostKeys: 1 }, /strictHostKeys/],
    [{ knownHosts: 3 }, /knownHosts/],
    [{ replayWindowMs: 0 }, /replayWindowMs/],
    [{ shell: 'bash' }, /absolute path/],
    [{ outputCapBytes: 0 }, /outputCapBytes/],
    [{ targets: { vm: 3 } }, /targets/],
    [{ transferChunkBytes: 32 * 1024 * 1024 }, /transferChunkBytes/],
    [{ transferChunkBytes: 1.5 }, /transferChunkBytes/],
    [{ transferCapBytes: -1 }, /transferCapBytes/],
    [{ workspace: 'other' }, /configured workspace/],
    [{ maxSessions: 1.5 }, /maxSessions/],
    [{ requestsPerMinute: 0 }, /requestsPerMinute/],
    [{ allowForwards: 'db:5432' }, /allowForwards/],
    [{ allowForwards: ['db'] }, /host:port/],
    [{ allowForwards: ['db:0'] }, /host:port/],
    [{ allowForwards: ['*:80'] }, /host:port/],
    [{ allowForwards: ['db:70000'] }, /host:port/],
    [{ auditLog: true }, /auditLog/],
    [{ auditLog: '' }, /auditLog/],
  ])('rejects %j', (shell, message) => {
    expect(() => parseShellConfig(shell, runtime(), '/etc')).toThrow(message);
  });

  it('normalises allowForwards entries to lowercase host:port', () => {
    const { allowForwards } = parseShellConfig(
      { allowForwards: ['DB.Internal:5432', '[::1]:80', '127.0.0.1:8080'] },
      runtime(),
      '/etc',
    );
    expect(allowForwards).toEqual(['db.internal:5432', '::1:80', '127.0.0.1:8080']);
  });

  it('resolves a relative ledger directory against the config file', () => {
    expect(parseShellConfig({ ledgerDir: 'ledger' }, runtime(), '/etc/ddshell').ledgerDir).toBe(
      '/etc/ddshell/ledger',
    );
  });
});
