import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { generateWorkspaceSecret } from '@fyrlabs/dead-drop/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ShellServer } from '../src/server.js';
import { VERSION, main, type Io } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { waitFor } from './helpers.js';

let root: string;
let home: string;
let server: ShellServer;
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
          // The first beacon predates the shell handler; the next one lists it.
          presenceIntervalMs: 50,
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

function terminalIo(): Io & {
  stdin: PassThrough & { isTTY: true; setRawMode(mode: boolean): PassThrough };
  out: () => string;
  err: () => string;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const chunks = { out: [] as Buffer[], err: [] as Buffer[] };
  stdout.on('data', (chunk: Buffer) => chunks.out.push(chunk));
  stderr.on('data', (chunk: Buffer) => chunks.err.push(chunk));
  const stdin = new PassThrough() as PassThrough & {
    isTTY: true;
    setRawMode(mode: boolean): PassThrough;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  return {
    stdin,
    stdout,
    stderr,
    env: {},
    out: () => Buffer.concat(chunks.out).toString(),
    err: () => Buffer.concat(chunks.err).toString(),
  };
}

async function waitForRunningJob(): Promise<void> {
  const ledger = join(root, 'vm-state', 'ddshell-ledger');
  const deadline = Date.now() + 3000;
  while (Date.now() <= deadline) {
    const names = await readdir(ledger).catch(() => [] as string[]);
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      const record = JSON.parse(await readFile(join(ledger, name), 'utf8')) as { state?: string };
      if (record.state === 'running') return;
    }
    await delay(25);
  }
  throw new Error('remote job did not start in time');
}

async function promptly<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    delay(2000).then(() => {
      throw new Error('interactive client did not exit promptly');
    }),
  ]);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ddshell-cli-')));
  home = join(root, 'home');
  await mkdir(home);
  const secretFile = join(root, 'secret');
  await writeFile(secretFile, `${generateWorkspaceSecret()}\n`, { mode: 0o600 });
  const serverConfig = await loadConfig(await writeConfig('vm', secretFile));
  server = await ShellServer.start({ ...serverConfig, home });
  controllerConfig = await writeConfig('laptop', secretFile);
});

afterEach(async () => {
  await server.stop();
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

  it('exec fans out to several servers, prefixing output and exiting with the worst code', async () => {
    const otherHome = join(root, 'home-two');
    await mkdir(otherHome);
    await writeFile(join(otherHome, 'marker'), 'two\n');
    const other = await ShellServer.start({
      ...(await loadConfig(await writeConfig('vm2', join(root, 'secret')))),
      home: otherHome,
    });
    try {
      const streams = io();
      const code = await main(
        ['exec', 'vm,vm2,vm', '--config', controllerConfig, '--', 'echo out; cat marker || exit 7'],
        streams,
      );
      expect(code).toBe(7);
      expect(streams.out().split('\n').sort()).toEqual(['', 'vm2: out', 'vm2: two', 'vm: out']);
      expect(streams.err()).toMatch(/^vm: cat: .*marker/);
    } finally {
      await other.stop();
    }
  });

  it('exec runs on every target at once', async () => {
    const otherHome = join(root, 'home-two');
    await mkdir(otherHome);
    const other = await ShellServer.start({
      ...(await loadConfig(await writeConfig('vm2', join(root, 'secret')))),
      home: otherHome,
    });
    try {
      // Each target waits for the other's mark, so this deadlocks if targets run in turn.
      const marks = join(root, 'marks');
      await mkdir(marks);
      const command = `touch '${marks}'/"$(basename "$HOME")"; until [ -e '${marks}/home' ] && [ -e '${marks}/home-two' ]; do sleep 0.05; done`;
      const streams = io();
      expect(
        await main(
          ['exec', 'vm,vm2', '--config', controllerConfig, '--timeout', '5000', '--', command],
          streams,
        ),
      ).toBe(0);
    } finally {
      await other.stop();
    }
  });

  it('exec reports a target that never answers as a ddshell failure', async () => {
    const streams = io();
    const code = await main(
      ['exec', 'vm,ghost', '--config', controllerConfig, '--timeout', '1000', '--', 'true'],
      streams,
    );
    expect(code).toBe(255);
    expect(streams.err()).toMatch(/^ghost: \[ddshell\] no answer within 1000ms/);
  });

  it('exec rejects an empty target in a list', async () => {
    const streams = io();
    expect(
      await main(['exec', 'vm,,vm2', '--config', controllerConfig, '--', 'true'], streams),
    ).toBe(255);
    expect(streams.err()).toMatch(/empty target/);
  });

  it('ping reports the server versions, uptime and round trip', async () => {
    const streams = io();
    expect(await main(['ping', 'vm', '--config', controllerConfig], streams)).toBe(0);
    const deadDrop = JSON.parse(
      await readFile(
        new URL('../node_modules/@fyrlabs/dead-drop/package.json', import.meta.url),
        'utf8',
      ),
    ).version;
    expect(streams.out()).toMatch(
      new RegExp(`^ddshell ${VERSION}, dead-drop ${deadDrop}, up \\d+s, round trip \\d+ ms\n$`),
    );
  });

  it('ping --count sends several and summarises them', async () => {
    const streams = io();
    expect(await main(['ping', 'vm', '--count', '3', '--config', controllerConfig], streams)).toBe(
      0,
    );
    const lines = streams.out().trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toMatch(/^3\/3 answered, round trip min \d+ ms, median \d+ ms, max \d+ ms$/);
  });

  it('ping exits 1 when a target does not answer', async () => {
    const streams = io();
    const code = await main(
      ['ping', 'vm,ghost', '--config', controllerConfig, '--timeout', '1000'],
      streams,
    );
    expect(code).toBe(1);
    expect(streams.out()).toMatch(/^vm: ddshell /);
    expect(streams.err()).toBe('ghost: [ddshell] no answer within 1000ms\n');
  });

  it('ping reports a controller the server refuses', async () => {
    const streams = io();
    const intruder = await writeConfig('mallory', join(root, 'secret'));
    expect(await main(['ping', 'vm', '--config', intruder], streams)).toBe(1);
    expect(streams.err()).toMatch(/UNAUTHORIZED: peer "mallory"/);
  });

  it('rejects a bad count before starting anything', async () => {
    const streams = io();
    expect(await main(['ping', 'vm', '--count', '0'], streams)).toBe(2);
    expect(streams.err()).toMatch(/--count/);
  });

  it('check passes a working controller config', async () => {
    let out = '';
    const deadline = Date.now() + 3000;
    while (!out.includes('target vm: peer vm serves') && Date.now() < deadline) {
      const streams = io();
      expect(await main(['check', '--config', controllerConfig], streams)).toBe(0);
      out = streams.out();
    }
    expect(out).toContain(`ok    config: ${controllerConfig}: workspace shell, peer laptop\n`);
    expect(out).toContain(`ok    secret: ${join(root, 'secret')} is readable by its owner only\n`);
    expect(out).toContain('ok    transport: filesystem (store) can be listed\n');
    expect(out).toMatch(/ok {4}target vm: peer vm serves shell\.v1, announced \d+s ago\n/);
  });

  it('check covers the server side of a config', async () => {
    const streams = io();
    expect(await main(['check', '--config', join(root, 'vm.json')], streams)).toBe(0);
    expect(streams.out()).toContain('ok    server: shell /bin/sh is executable\n');
    expect(streams.out()).toMatch(/ok {4}server: ledger .*ddshell-ledger can be written\n/);
    expect(streams.out()).toContain('ok    server: allows laptop\n');
  });

  it('check fails on an unreadable config, a missing shell and a broken transport', async () => {
    const missing = io();
    expect(await main(['check', '--config', join(root, 'nope.json')], missing)).toBe(1);
    expect(missing.out()).toMatch(/^fail {2}config: CONFIG_INVALID: cannot read config file/);

    await writeFile(join(root, 'not-a-dir'), 'file');
    const broken = join(root, 'broken.json');
    const config = JSON.parse(await readFile(join(root, 'vm.json'), 'utf8'));
    config.workspaces[0].transports[0].config.root = './not-a-dir';
    config.shell.shell = '/no/such/shell';
    await writeFile(broken, JSON.stringify(config));
    const streams = io();
    expect(await main(['check', '--config', broken], streams)).toBe(1);
    expect(streams.out()).toContain(
      'fail  server: shell /no/such/shell is missing or not executable\n',
    );
    expect(streams.out()).toMatch(/fail {2}transport: filesystem: .*ENOTDIR/);
    expect(streams.out()).toMatch(/warn {2}target vm: peer vm has no recent beacon/);
  });

  it('check warns about a secret other accounts can read', async () => {
    await chmod(join(root, 'secret'), 0o644);
    const streams = io();
    expect(await main(['check', '--config', controllerConfig], streams)).toBe(0);
    expect(streams.out()).toContain(
      `warn  secret: ${join(root, 'secret')} has mode 644; run chmod 600 on it\n`,
    );
  });

  it('runs an interactive session from piped input, keeping cd', async () => {
    const streams = io('cd /\npwd\necho "$HOME"\n');
    const code = await main(['vm', '--config', controllerConfig], streams);
    expect(code).toBe(0);
    // No prompts: like a shell, they are for terminals only.
    expect(streams.out()).toBe(`/\n${home}\n`);
  });

  it('Ctrl-D closes an opened interactive session', async () => {
    const streams = terminalIo();
    const running = main(['vm', '--config', controllerConfig], streams);
    await waitFor(() => streams.out().includes('vm:~$ '));

    streams.stdin.write('echo ready\n');
    await waitFor(() => streams.out().split('vm:~$ ').length >= 3);
    streams.stdin.write('\u0004');

    expect(await promptly(running)).toBe(0);
  });

  it('Ctrl-D abandons a pending command without waiting for its timeout', async () => {
    const streams = terminalIo();
    const running = main(['vm', '--config', controllerConfig], streams);
    await waitFor(() => streams.out().includes('vm:~$ '));

    streams.stdin.write('sleep 30\n');
    await waitForRunningJob();
    streams.stdin.write('\u0004');

    expect(await promptly(running)).toBe(0);
  });

  it('a second Ctrl-C abandons a pending command immediately', async () => {
    const streams = terminalIo();
    const running = main(['vm', '--config', controllerConfig], streams);
    await waitFor(() => streams.out().includes('vm:~$ '));

    streams.stdin.write('sleep 30\n');
    await waitForRunningJob();
    streams.stdin.write('\u0003');
    await waitFor(() => streams.err().includes('Press Ctrl-C again to leave'));
    streams.stdin.write('\u0003');

    expect(await promptly(running)).toBe(0);
  });

  it('cp puts, gets and relays files with target:path, as scp does', async () => {
    const file = join(root, 'notes.txt');
    await writeFile(file, 'remember\n');
    const put = io();
    expect(await main(['cp', file, 'vm:', '--config', controllerConfig], put)).toBe(0);
    expect(put.err()).toBe('');
    expect(await readFile(join(home, 'notes.txt'), 'utf8')).toBe('remember\n');

    expect(
      await main(['cp', 'vm:notes.txt', 'vm:copy.txt', '--config', controllerConfig], io()),
    ).toBe(0);
    expect(await readFile(join(home, 'copy.txt'), 'utf8')).toBe('remember\n');

    const get = io();
    const back = join(root, 'back.txt');
    expect(
      await main(['get', 'vm', 'copy.txt', back, '--config', controllerConfig, '--debug'], get),
    ).toBe(0);
    expect(await readFile(back, 'utf8')).toBe('remember\n');
    expect(get.err()).toMatch(/vm:copy\.txt -> .*back\.txt, 9 bytes, sha256 [0-9a-f]{64}/);
  });

  it('cp -r copies directories both ways and exits 1 when it skips something', async () => {
    const tree = join(root, 'site');
    await mkdir(join(tree, 'css'), { recursive: true });
    await writeFile(join(tree, 'index.html'), '<p>hi</p>');
    await writeFile(join(tree, 'css', 'main.css'), 'p {}');
    expect(await main(['cp', '-r', tree, 'vm:', '--config', controllerConfig], io())).toBe(0);
    expect(await readFile(join(home, 'site', 'css', 'main.css'), 'utf8')).toBe('p {}');

    const back = join(root, 'back');
    expect(await main(['cp', '-r', 'vm:site', back, '--config', controllerConfig], io())).toBe(0);
    expect(await readFile(join(back, 'index.html'), 'utf8')).toBe('<p>hi</p>');

    await symlink('nowhere', join(tree, 'dangling'));
    const skipped = io();
    expect(
      await main(['put', '-r', 'vm', tree, 'again', '--config', controllerConfig], skipped),
    ).toBe(1);
    expect(skipped.err()).toMatch(/skipped dangling: broken symbolic link/);
    expect(await readFile(join(home, 'again', 'index.html'), 'utf8')).toBe('<p>hi</p>');
  });

  it('put and get exit 1 with the reason when a copy fails', async () => {
    const streams = io();
    expect(await main(['get', 'vm', 'missing', root, '--config', controllerConfig], streams)).toBe(
      1,
    );
    expect(streams.err()).toMatch(/vm:missing: NOT_FOUND: no such file or directory/);
    expect(
      await main(['put', 'vm', join(root, 'missing'), 'x', '--config', controllerConfig], io()),
    ).toBe(1);
  });

  it('cp needs a target on one side and get takes one target', async () => {
    const both = io();
    expect(await main(['cp', 'a', 'b', '--config', controllerConfig], both)).toBe(255);
    expect(both.err()).toMatch(/<target>:<path>/);
    expect(await main(['get', 'vm,vm2', 'a', 'b', '--config', controllerConfig], io())).toBe(255);
    expect(await main(['cp', './a:b', 'c', '--config', controllerConfig], io())).toBe(255);
  });

  it('rejects a bad timeout before starting anything', async () => {
    const streams = io();
    expect(await main(['vm', '--timeout', 'soon'], streams)).toBe(2);
    expect(streams.err()).toMatch(/--timeout/);
  });
});
