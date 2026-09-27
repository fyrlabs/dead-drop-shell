import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { generateWorkspaceSecret } from '@fyrlabs/dead-drop/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ShellAgent } from '../src/agent.js';
import { VERSION, main, type Io } from '../src/cli.js';
import { loadConfig } from '../src/config.js';

let root: string;
let home: string;
let agent: ShellAgent;
let controllerConfig: string;

async function writeConfig(peerId: string, secretFile: string): Promise<string> {
  const path = join(root, `${peerId}.json`);
  await writeFile(
    path,
    JSON.stringify({
      dataDir: `./${peerId}-state`,
      logLevel: 'silent',
      workspaces: [
        {
          name: 'shell',
          peerId,
          secrets: [`\${file:${secretFile}}`],
          transports: [{ use: 'filesystem', config: { root: './store' } }],
          polling: { minIntervalMs: 20, maxIntervalMs: 100 },
        },
      ],
      shell: { allowControllers: ['laptop'], targets: { vm: 'vm' } },
    }),
  );
  return path;
}

function io(input = ''): Io & { out: () => string; err: () => string } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const chunks = { out: [] as Buffer[], err: [] as Buffer[] };
  stdout.on('data', (chunk: Buffer) => chunks.out.push(chunk));
  stderr.on('data', (chunk: Buffer) => chunks.err.push(chunk));
  const stdin = new PassThrough();
  stdin.end(input);
  return {
    stdin,
    stdout,
    stderr,
    env: {},
    out: () => Buffer.concat(chunks.out).toString(),
    err: () => Buffer.concat(chunks.err).toString(),
  };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ddshell-cli-')));
  home = join(root, 'home');
  await mkdir(home);
  const secretFile = join(root, 'secret');
  await writeFile(secretFile, `${generateWorkspaceSecret()}\n`, { mode: 0o600 });
  const agentConfig = await loadConfig(await writeConfig('vm', secretFile));
  agent = await ShellAgent.start({ ...agentConfig, home });
  controllerConfig = await writeConfig('laptop', secretFile);
});

afterEach(async () => {
  await agent.stop();
  await rm(root, { recursive: true, force: true });
});

describe('ddshell cli', () => {
  it('reports the package version', async () => {
    const streams = io();
    expect(await main(['--version'], streams)).toBe(0);
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );
    expect(streams.out()).toBe(`${manifest.version}\n`);
    expect(VERSION).toBe(manifest.version);
  });

  it('exec prints output and exits with the remote exit code', async () => {
    const streams = io();
    const code = await main(
      [
        'exec',
        'vm',
        '--config',
        controllerConfig,
        '--',
        'echo',
        'hi;',
        'echo',
        'oops',
        '>&2;',
        'exit',
        '3',
      ],
      streams,
    );
    expect(streams.out()).toBe('hi\n');
    expect(streams.err()).toBe('oops\n');
    expect(code).toBe(3);
  });

  it('runs an interactive session from piped input, keeping cd', async () => {
    const streams = io('cd /\npwd\necho "$HOME"\n');
    const code = await main(['vm', '--config', controllerConfig], streams);
    expect(code).toBe(0);
    // No prompts: like a shell, they are for terminals only.
    expect(streams.out()).toBe(`/\n${home}\n`);
  });

  it('rejects a bad timeout before starting anything', async () => {
    const streams = io();
    expect(await main(['vm', '--timeout', 'soon'], streams)).toBe(2);
    expect(streams.err()).toMatch(/--timeout/);
  });
});
