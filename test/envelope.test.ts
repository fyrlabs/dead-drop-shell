import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeadDropError } from '@fyrlabs/dead-drop/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  answerHello,
  helloRequest,
  openAnswer,
  openHello,
  openRequest,
  pack,
  ReplayGuard,
  sealAnswer,
  sealCall,
  unpack,
} from '../src/envelope.js';
import {
  formatPublicKey,
  generateKeyPair,
  KnownHosts,
  parsePublicKey,
  readKeyPair,
  writeKeyPair,
  type KeyPair,
} from '../src/keys.js';

let dir: string;
let host: KeyPair;
let laptop: KeyPair;
let guard: ReplayGuard;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ddshell-envelope-'));
  host = generateKeyPair();
  laptop = generateKeyPair();
  guard = new ReplayGuard(join(dir, 'seen'), 60_000);
  await guard.open();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const only = (key: KeyPair) => (fingerprint: string) =>
  fingerprint === key.fingerprint ? key : undefined;

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (error: unknown) => {
      if (!DeadDropError.is(error)) throw error;
      return error;
    },
  );

const thrown = (step: () => unknown) => refusal(Promise.resolve().then(step));

describe('keys', () => {
  it('round-trips a public key line and its comment', () => {
    const parsed = parsePublicKey(formatPublicKey(laptop, 'me@laptop'));
    expect(parsed.fingerprint).toBe(laptop.fingerprint);
    expect(parsed.comment).toBe('me@laptop');
    expect(laptop.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it.each([
    ['ssh-ed25519 AAAA'],
    ['ddshell-key'],
    [`ddshell-key ${Buffer.alloc(32).toString('base64')}`],
  ])('refuses %j as a public key', (line) => {
    expect(() => parsePublicKey(line)).toThrow(/not a ddshell public key/);
  });

  it('writes a private key only its owner can read and will not replace it', async () => {
    const path = join(dir, 'key');
    await writeKeyPair(path, laptop, 'me');
    expect((await readKeyPair(path)).fingerprint).toBe(laptop.fingerprint);
    expect(await readFile(`${path}.pub`, 'utf8')).toBe(`${formatPublicKey(laptop, 'me')}\n`);
    await expect(writeKeyPair(path, generateKeyPair(), 'me')).rejects.toThrow(/already exists/);
    await writeKeyPair(path, host, 'me', true);
    expect((await readKeyPair(path)).fingerprint).toBe(host.fingerprint);

    await chmod(path, 0o644);
    await expect(readKeyPair(path)).rejects.toThrow(/readable by other users/);
    await writeFile(join(dir, 'junk'), 'nothing', { mode: 0o600 });
    await expect(readKeyPair(join(dir, 'junk'))).rejects.toThrow(/not a ddshell key/);
  });

  it('remembers one host key per peer', async () => {
    const known = new KnownHosts(join(dir, 'known_hosts'));
    expect(await known.get('vm')).toBeUndefined();
    await known.add('vm', host);
    await known.add('vm2', laptop);
    expect((await known.get('vm'))?.fingerprint).toBe(host.fingerprint);
    expect((await known.get('vm2'))?.fingerprint).toBe(laptop.fingerprint);
    expect(await known.get('v')).toBeUndefined();
  });
});

describe('shell.v2 envelope', () => {
  it('carries a request and its answer, moving binary fields as raw bytes', async () => {
    const stdout = Buffer.from([0, 255, 10, 13]).toString('base64');
    const { bytes, sig } = sealCall({ v: 1, op: 'exec', command: 'secret words' }, laptop, host);
    expect(bytes.includes(Buffer.from('secret words'))).toBe(false);

    const opened = await openRequest(bytes, host, only(laptop), guard);
    if (opened.kind !== 'call') throw new Error('expected a call');
    expect(opened.client.fingerprint).toBe(laptop.fingerprint);
    expect(opened.request).toEqual({ v: 1, op: 'exec', command: 'secret words' });

    const answer = sealAnswer({ result: { exitCode: 0, stdout } }, opened.client, opened.sig, host);
    expect(openAnswer(answer, laptop, host, sig)).toEqual({ exitCode: 0, stdout });
    expect(unpack(pack({ stdout, stderr: '' }))).toEqual({ stdout, stderr: '' });
  });

  it('delivers an error the server threw as that error', async () => {
    const { bytes, sig } = sealCall({ v: 1, op: 'ping' }, laptop, host);
    const opened = await openRequest(bytes, host, only(laptop), guard);
    if (opened.kind !== 'call') throw new Error('expected a call');
    const answer = sealAnswer(
      { error: new DeadDropError('NOT_FOUND', 'no such file') },
      opened.client,
      opened.sig,
      host,
    );
    const error = await thrown(() => openAnswer(answer, laptop, host, sig));
    expect(error).toMatchObject({ code: 'NOT_FOUND', message: 'no such file' });
  });

  it('refuses a key the server has not authorised', async () => {
    const { bytes } = sealCall({ v: 1, op: 'ping' }, generateKeyPair(), host);
    const error = await refusal(openRequest(bytes, host, only(laptop), guard));
    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.message).toMatch(/not in this server's shell.authorizedKeys/);
  });

  it('refuses a request whose bytes were changed on the way', async () => {
    const { bytes } = sealCall({ v: 1, op: 'ping' }, laptop, host);
    bytes[bytes.length - 1]! ^= 1;
    const error = await refusal(openRequest(bytes, host, only(laptop), guard));
    expect(error.message).toMatch(/signature does not verify/);
  });

  it('refuses a request sealed to another host key', async () => {
    const { bytes } = sealCall({ v: 1, op: 'ping' }, laptop, generateKeyPair());
    const error = await refusal(openRequest(bytes, host, only(laptop), guard));
    expect(error.message).toMatch(/sealed to host key/);
  });

  it('refuses the same request twice, even after a restart', async () => {
    const { bytes } = sealCall({ v: 1, op: 'ping' }, laptop, host);
    await openRequest(bytes, host, only(laptop), guard);
    expect((await refusal(openRequest(bytes, host, only(laptop), guard))).code).toBe(
      'REPLAY_DETECTED',
    );

    const restarted = new ReplayGuard(join(dir, 'seen'), 60_000);
    await restarted.open();
    expect((await refusal(openRequest(bytes, host, only(laptop), restarted))).code).toBe(
      'REPLAY_DETECTED',
    );
  });

  it('refuses a request timestamped outside the replay window', async () => {
    const { bytes } = sealCall({ v: 1, op: 'ping' }, laptop, host, Date.now() - 120_000);
    const error = await refusal(openRequest(bytes, host, only(laptop), guard));
    expect(error.message).toMatch(/outside the 60 s replay window/);
  });

  it('forgets nonces once their window has passed', async () => {
    let now = 1_000_000;
    const clocked = new ReplayGuard(join(dir, 'clocked'), 1_000, () => now);
    await clocked.open();
    await clocked.check(now, 'n');
    await expect(clocked.check(now, 'n')).rejects.toThrow(/already received/);
    now += 5_000;
    await clocked.compact();
    expect(await readFile(join(dir, 'clocked'), 'utf8')).toBe('');
  });

  it('refuses an answer that is not for this request, not from the pinned host, or changed', async () => {
    const first = sealCall({ v: 1, op: 'ping' }, laptop, host);
    const second = sealCall({ v: 1, op: 'ping' }, laptop, host);
    const answer = sealAnswer({ result: { ok: true } }, laptop, first.sig, host);

    const swapped = await thrown(() => openAnswer(answer, laptop, host, second.sig));
    expect(swapped.code).toBe('UNAUTHORIZED');
    const impostor = sealAnswer({ result: { ok: true } }, laptop, first.sig, generateKeyPair());
    expect((await thrown(() => openAnswer(impostor, laptop, host, first.sig))).code).toBe(
      'UNAUTHORIZED',
    );
    const changed = Buffer.from(answer);
    changed[changed.length - 1]! ^= 1;
    expect((await thrown(() => openAnswer(changed, laptop, host, first.sig))).code).toBe(
      'UNAUTHORIZED',
    );
  });

  it('lets no other key read an answer', async () => {
    const { sig } = sealCall({ v: 1, op: 'ping' }, laptop, host);
    const answer = sealAnswer({ result: { stdout: 'c2VjcmV0' } }, laptop, sig, host);
    const error = await thrown(() => openAnswer(answer, generateKeyPair(), host, sig));
    expect(error.code).toBe('DECRYPT_FAILED');
  });

  it('proves the host key in a hello, bound to peer and nonce', async () => {
    const { bytes, nonce } = helloRequest();
    const opened = await openRequest(bytes, host, only(laptop), guard);
    expect(opened).toEqual({ kind: 'hello', nonce });

    const answer = answerHello(host, 'vm', nonce);
    expect(openHello(answer, 'vm', nonce).fingerprint).toBe(host.fingerprint);
    expect((await thrown(() => openHello(answer, 'vm2', nonce))).code).toBe('UNAUTHORIZED');
    expect((await thrown(() => openHello(answer, 'vm', helloRequest().nonce))).code).toBe(
      'UNAUTHORIZED',
    );
  });

  it.each([[Buffer.alloc(0)], [Buffer.from([0, 0, 0, 9, 1])], [Buffer.from('\0\0\0\u0002{x')]])(
    'refuses malformed bytes %#',
    async (bytes) => {
      expect((await refusal(openRequest(bytes, host, only(laptop), guard))).code).toBe(
        'BAD_REQUEST',
      );
    },
  );
});
