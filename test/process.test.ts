import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { generateWorkspaceSecret } from '@fyrlabs/dead-drop/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { waitFor } from './helpers.js';

// Runs the built binary, so `npm test` builds first (the pretest script).
const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

let root: string;
let server: ChildProcess | undefined;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ddshell-proc-')));
  await mkdir(join(root, 'home'));
  await promisify(execFile)('git', ['init', '--bare', '--quiet', join(root, 'remote.git')]);
  await writeFile(join(root, 'secret'), generateWorkspaceSecret(), { mode: 0o600 });
});

afterEach(async () => {
  server?.kill('SIGKILL');
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

async function writeConfig(peerId: string): Promise<string> {
  const path = join(root, `${peerId}.json`);
  await writeFile(
    path,
    JSON.stringify({
      dataDir: join(root, `${peerId}-state`),
      logLevel: 'info',
      workspaces: [
        {
          name: 'shell',
          peerId,
          secrets: [`\${file:${join(root, 'secret')}}`],
          transports: [
            {
              use: 'git',
              config: {
                remote: join(root, 'remote.git'),
                workDir: join(root, `${peerId}-git`),
                // The 5 s default would make every hop wait for a forced fetch.
                freshnessMs: 100,
              },
            },
          ],
          polling: { minIntervalMs: 50, maxIntervalMs: 200 },
        },
      ],
      shell: { allowControllers: ['laptop'], targets: { vm: 'vm' } },
    }),
  );
  return path;
}

function run(args: string[]): { child: ChildProcess; output: () => string } {
  const child = spawn(process.execPath, [bin, ...args], {
    cwd: join(root, 'home'),
    env: { PATH: process.env.PATH, HOME: join(root, 'home') },
  });
  let output = '';
  child.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()));
  return { child, output: () => output };
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

// Over git and GitHub, dead-drop's unref'd poll timers were the only thing
// pending, so Node exited with code 13 before serving or answering anything.
// The filesystem transport's fs.watch handle hides this, so it takes real
// processes over the git transport to catch it.
describe('ddshell processes over the git transport', () => {
  it('stays up and carries the remote exit code back', async () => {
    const serving = run(['serve', '--config', await writeConfig('vm')]);
    server = serving.child;
    await waitFor(() => serving.output().includes('shell server ready'), 15_000);

    const exec = run([
      'exec',
      'vm',
      '--config',
      await writeConfig('laptop'),
      '--timeout',
      '10000',
      '--',
      'echo hi; exit 3',
    ]);
    const code = await exited(exec.child);
    expect(code, exec.output()).toBe(3);
    expect(exec.output()).toContain('hi');
    expect(server.exitCode).toBeNull();

    server.kill('SIGTERM');
    expect(await exited(server)).toBe(0);
  }, 30_000);
});
