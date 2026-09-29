import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { appendFile, open, readFile, stat, writeFile } from 'node:fs/promises';

import { DeadDropError } from '@fyrlabs/dead-drop/protocol';

/** First word of every public key line. */
export const KEY_TYPE = 'ddshell-key';

/** Someone's public half: an Ed25519 key that signs and an X25519 key that is sealed to. */
export interface PublicKey {
  sign: KeyObject;
  box: KeyObject;
  /** 64 bytes: the raw Ed25519 key, then the raw X25519 key. */
  raw: Buffer;
  /** `SHA256:` and the unpadded base64 of the sha256 of `raw`, like ssh. */
  fingerprint: string;
}

export interface KeyPair extends PublicKey {
  signPrivate: KeyObject;
  boxPrivate: KeyObject;
}

function rawPublic(key: KeyObject): Buffer {
  return Buffer.from(key.export({ format: 'jwk' }).x!, 'base64url');
}

function importPublic(crv: 'Ed25519' | 'X25519', raw: Buffer): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv, x: raw.toString('base64url') }, format: 'jwk' });
}

function publicKey(sign: KeyObject, box: KeyObject): PublicKey {
  const raw = Buffer.concat([rawPublic(sign), rawPublic(box)]);
  return { sign, box, raw, fingerprint: fingerprint(raw) };
}

export function fingerprint(raw: Buffer): string {
  return `SHA256:${createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')}`;
}

export function generateKeyPair(): KeyPair {
  const sign = generateKeyPairSync('ed25519');
  const box = generateKeyPairSync('x25519');
  return {
    ...publicKey(sign.publicKey, box.publicKey),
    signPrivate: sign.privateKey,
    boxPrivate: box.privateKey,
  };
}

/** `ddshell-key <base64> [comment]`: what goes in `authorizedKeys` and in a `.pub` file. */
export function formatPublicKey(key: PublicKey, comment?: string): string {
  return [KEY_TYPE, key.raw.toString('base64'), ...(comment ? [comment] : [])].join(' ');
}

export function parsePublicKey(line: string): PublicKey & { comment: string } {
  const [type, data, ...comment] = line.trim().split(/\s+/);
  const raw = Buffer.from(data ?? '', 'base64');
  if (type !== KEY_TYPE || raw.length !== 64 || raw.toString('base64') !== data) {
    throw new DeadDropError(
      'CONFIG_INVALID',
      `not a ddshell public key: expected "${KEY_TYPE} <base64> [comment]"`,
    );
  }
  return {
    ...publicKey(
      importPublic('Ed25519', raw.subarray(0, 32)),
      importPublic('X25519', raw.subarray(32)),
    ),
    comment: comment.join(' '),
  };
}

function formatPrivate(pair: KeyPair): string {
  return [pair.signPrivate, pair.boxPrivate]
    .map((key) => key.export({ format: 'pem', type: 'pkcs8' }).toString())
    .join('');
}

/**
 * Writes a new key pair to `path` (mode 0600) and its public line to
 * `path.pub`. Refuses to replace an existing key unless `force`: whoever
 * authorised the old one would silently lose access.
 */
export async function writeKeyPair(
  path: string,
  pair: KeyPair,
  comment: string,
  force = false,
): Promise<void> {
  const handle = await open(path, force ? 'w' : 'wx', 0o600).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new DeadDropError(
        'CONFIG_INVALID',
        `${path} already exists; pass --force to replace it`,
      );
    }
    throw error;
  });
  try {
    await handle.chmod(0o600);
    await handle.writeFile(formatPrivate(pair));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await writeFile(`${path}.pub`, `${formatPublicKey(pair, comment)}\n`, { mode: 0o644 });
}

/** Refuses a key file anyone but its owner can read, as ssh does. */
export async function readKeyPair(path: string): Promise<KeyPair> {
  const stats = await stat(path);
  if ((stats.mode & 0o077) !== 0) {
    throw new DeadDropError(
      'CONFIG_INVALID',
      `${path} is readable by other users (mode ${(stats.mode & 0o777).toString(8)}); chmod 600 it`,
    );
  }
  const blocks = (await readFile(path, 'utf8')).match(
    /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/g,
  );
  const [signPrivate, boxPrivate] = (blocks ?? []).map((pem) => createPrivateKey(pem));
  if (signPrivate?.asymmetricKeyType !== 'ed25519' || boxPrivate?.asymmetricKeyType !== 'x25519') {
    throw new DeadDropError(
      'CONFIG_INVALID',
      `${path} is not a ddshell key; make one with ddshell keygen`,
    );
  }
  return {
    ...publicKey(createPublicKey(signPrivate), createPublicKey(boxPrivate)),
    signPrivate,
    boxPrivate,
  };
}

/** Reads the key at `path`, or makes one there first. For a server's host key. */
export async function ensureKeyPair(path: string, comment: string): Promise<KeyPair> {
  try {
    return await readKeyPair(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await writeKeyPair(path, generateKeyPair(), comment);
  } catch (error) {
    // Two processes raced to make it; the other one won.
    if (!(DeadDropError.is(error) && /already exists/.test(error.message))) throw error;
  }
  return readKeyPair(path);
}

/**
 * The controller's record of which host key each server peer id showed first,
 * one `<peerId> ddshell-key <base64>` line each, like ssh's known_hosts.
 */
export class KnownHosts {
  constructor(private readonly path: string) {}

  async get(peer: string): Promise<PublicKey | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    for (const line of text.split('\n')) {
      const [name, ...key] = line.trim().split(/\s+/);
      if (name === peer && key.length > 0) return parsePublicKey(key.join(' '));
    }
    return undefined;
  }

  async add(peer: string, key: PublicKey): Promise<void> {
    await appendFile(this.path, `${peer} ${formatPublicKey(key)}\n`, { mode: 0o600 });
  }
}
