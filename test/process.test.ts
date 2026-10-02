import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { generateWorkspaceSecret } from '@fyrlabs/dead-drop/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { keyLines, waitFor } from './helpers.js';

// Runs the built binary, so `npm test` builds first (the pretest script).
const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

let root: string;
let server: ChildProcess | undefined;
const extraServers: ChildProcess[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ddshell-proc-')));
  await mkdir(join(root, 'home'));
  await promisify(execFile)('git', ['init', '--bare', '--quiet', join(root, 'remote.git')]);
  await writeFile(join(root, 'secret'), generateWorkspaceSecret(), { mode: 0o600 });
});

afterEach(async () => {
  for (const child of extraServers.splice(0)) child.kill('SIGKILL');
  server?.kill('SIGKILL');
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

async function writeConfig(peerId: string): Promise<string> {
  const path = join(root, `${peerId}.json`);
  await keyLines(root, [peerId]);
  const authorizedKeys = await keyLines(root, ['laptop']);
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
      // Small chunks make an upload many requests, not one.
      shell: {
        authorizedKeys,
        key: join(root, `${peerId}.key`),
        hostKey: join(root, `${peerId}.host_key`),
        knownHosts: join(root, `${peerId}.known_hosts`),
        targets: { vm: 'vm', vm2: 'vm2' },
        transferChunkBytes: 4096,
      },
    }),
  );
  return path;
}

/**
 * The same peers over the filesystem transport. It answers far faster than git,
 * so the client's stdout is still queued when `main` returns, which is what
 * makes lost output reproducible here rather than a matter of timing.
 */
async function writeFsConfig(peerId: string): Promise<string> {
  const path = join(root, `${peerId}.json`);
  await keyLines(root, [peerId]);
  const authorizedKeys = await keyLines(root, ['laptop']);
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
          transports: [{ use: 'filesystem', config: { root: join(root, 'store') } }],
          polling: { minIntervalMs: 20, maxIntervalMs: 50 },
        },
      ],
      shell: {
        authorizedKeys,
        key: join(root, `${peerId}.key`),
        hostKey: join(root, `${peerId}.host_key`),
        knownHosts: join(root, `${peerId}.known_hosts`),
        targets: { vm: 'vm', vm2: 'vm2' },
      },
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
describe('ddshell processes', () => {
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

  it('Ctrl-C on exec cancels the remote command and exits 130', async () => {
    const serving = run(['serve', '--config', await writeConfig('vm')]);
    server = serving.child;
    await waitFor(() => serving.output().includes('shell server ready'), 15_000);

    const exec = run([
      'exec',
      'vm',
      '--config',
      await writeConfig('laptop'),
      '--',
      'echo st""arted; sleep 30; echo af""ter',
    ]);
    await waitFor(() => exec.output().includes('started'), 20_000);
    exec.child.kill('SIGINT');
    expect(await exited(exec.child), exec.output()).toBe(130);
    expect(exec.output()).not.toContain('after');
    expect(exec.output()).toContain('cancelling');

    server.kill('SIGTERM');
    expect(await exited(server)).toBe(0);
  }, 60_000);

  // `process.exit()` right after `main` returned dropped whatever stdout had not
  // handed to the OS yet. To a pipe or a file that is real output, so
  // `ddshell exec a,b -- big` lost most of both targets' bytes: fan-out holds
  // each target's output back and writes it as one block at the end, so the
  // whole command is still queued when `main` returns.
  // In-process tests cannot see this: their `Io` is an in-memory buffer whose
  // `write` always accepts, so only the real binary and a real pipe show it.
  it('delivers all of a large fan-out output through a pipe', async () => {
    for (const peer of ['vm', 'vm2']) {
      const serving = run(['serve', '--config', await writeFsConfig(peer)]);
      extraServers.push(serving.child);
      await waitFor(() => serving.output().includes('shell server ready'), 15_000);
    }
    const bytes = 200_000;
    const exec = spawn(
      process.execPath,
      [
        bin,
        'exec',
        'vm,vm2',
        '--config',
        await writeFsConfig('laptop'),
        '--timeout',
        '60000',
        '--',
        `head -c ${bytes} /dev/zero | tr '\\0' 'a'`,
      ],
      { cwd: join(root, 'home'), env: { PATH: process.env.PATH, HOME: join(root, 'home') } },
    );
    let seen = '';
    // A reader that cannot keep up, as `| less` or a file on a slow disk is.
    // Pausing is what makes it real: without it the event loop drains the pipe
    // as fast as ddshell fills it and there is no backpressure to feel.
    let backlog = Promise.resolve();
    exec.stdout!.on('data', (chunk: Buffer) => {
      seen += chunk.toString();
      exec.stdout!.pause();
      backlog = backlog.then(
        () => new Promise((resolve) => setTimeout(() => (exec.stdout!.resume(), resolve()), 2)),
      );
    });
    let errors = '';
    exec.stderr!.on('data', (chunk: Buffer) => (errors += chunk.toString()));
    const code = await exited(exec);
    await backlog;
    expect(code, errors).toBe(0);
    // Each target contributes `bytes` plus one 'vmN: ' prefix per line.
    expect(
      seen.length,
      `lost ${bytes * 2 - seen.length} bytes of ${bytes * 2}`,
    ).toBeGreaterThanOrEqual(bytes * 2);

    for (const child of extraServers) child.kill('SIGTERM');
    for (const child of extraServers) expect(await exited(child)).toBe(0);
    extraServers.length = 0;
  }, 90_000);

  // Up to dead-drop 0.16.0 the mailbox stopped polling while a handler ran,
  // so one long command held up every other request to the server.
  it('answers pings, uploads and other commands while a long command runs', async () => {
    const serving = run(['serve', '--config', await writeConfig('vm')]);
    server = serving.child;
    await waitFor(() => serving.output().includes('shell server ready'), 15_000);
    const laptop = await writeConfig('laptop');
    const home = join(root, 'home');
    const ddshell = async (command: string, ...args: string[]) => {
      const started = run([command, '--config', laptop, '--timeout', '20000', ...args]);
      const code = await exited(started.child);
      expect(code, started.output()).toBe(0);
      return started.output();
    };

    const long = run([
      'exec',
      'vm',
      '--config',
      laptop,
      '--timeout',
      '60000',
      '--',
      `touch started; until [ -e release ]; do sleep 0.1; done; echo released`,
    ]);
    await waitFor(() => existsSync(join(home, 'started')), 20_000);

    expect(await ddshell('ping', 'vm')).toContain('round trip');
    const upload = randomBytes(40_000);
    await writeFile(join(root, 'upload.bin'), upload);
    await ddshell('put', 'vm', join(root, 'upload.bin'), 'upload.bin');
    expect(await readFile(join(home, 'upload.bin'))).toEqual(upload);
    const outputs = await Promise.all(
      ['one', 'two', 'three'].map((word) => ddshell('exec', 'vm', '--', `echo ${word}`)),
    );
    expect(outputs.map((output) => output.trim())).toEqual(['one', 'two', 'three']);
    expect(long.child.exitCode).toBeNull();

    await ddshell('exec', 'vm', '--', 'touch release');
    expect(await exited(long.child), long.output()).toBe(0);
    expect(long.output()).toContain('released');
  }, 90_000);
});
