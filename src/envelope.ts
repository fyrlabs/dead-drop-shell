import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { appendFile, open, readFile, rename } from 'node:fs/promises';

import { DeadDropError } from '@fyrlabs/dead-drop/protocol';

import { KEY_TYPE, parsePublicKey, type KeyPair, type PublicKey } from './keys.js';

/**
 * `shell.v2` carries the v1 operations inside a signed, sealed envelope:
 *
 * - every request is signed by the controller's Ed25519 key, so the server
 *   knows who sent it without trusting dead-drop's peer ids, which any holder
 *   of the workspace secret can claim;
 * - requests are sealed to the server's X25519 host key and answers to the
 *   controller's, so other workspace members read neither commands nor output;
 * - every answer is signed by the host key and names the request it answers,
 *   so nobody else in the workspace can forge or swap one.
 *
 * Wire form of every message: a 4-byte big-endian header length, a JSON
 * header, then raw bytes. dead-drop carries binary payloads as they are.
 */
export const SEALED_TYPE = 'application/vnd.ddshell.sealed';

/** Answer fields that are base64 in v1. v2 moves them as raw bytes instead. */
const BINARY_FIELDS = ['data', 'stdout', 'stderr'] as const;

interface CallHeader {
  v: 2;
  kind: 'call';
  /** Controller key fingerprint. */
  client: string;
  /** Host key fingerprint the controller sealed to. */
  host: string;
  ts: number;
  nonce: string;
  eph: string;
  iv: string;
  sig: string;
}

interface HelloHeader {
  v: 2;
  kind: 'hello';
  nonce: string;
}

interface AnswerHeader {
  eph: string;
  iv: string;
  sig: string;
}

interface HelloAnswer {
  key: string;
  sig: string;
}

function frame(header: object, body: Uint8Array = Buffer.alloc(0)): Buffer {
  const json = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([length, json, body]);
}

function unframe<Header>(bytes: Uint8Array): { header: Header; body: Buffer } {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = buffer.length >= 4 ? buffer.readUInt32BE(0) : -1;
  if (length < 0 || 4 + length > buffer.length) {
    throw new DeadDropError('BAD_REQUEST', 'malformed shell.v2 message');
  }
  try {
    const header = JSON.parse(buffer.subarray(4, 4 + length).toString()) as Header;
    return { header, body: buffer.subarray(4 + length) };
  } catch {
    throw new DeadDropError('BAD_REQUEST', 'malformed shell.v2 message');
  }
}

/** Length-prefixed, so no two different field lists hash alike. */
function transcript(domain: string, ...parts: Array<string | Uint8Array>): Buffer {
  const hash = createHash('sha256');
  for (const part of [domain, ...parts]) {
    const bytes = typeof part === 'string' ? Buffer.from(part) : part;
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return hash.digest();
}

/** Moves the base64 binary fields out of JSON as raw bytes. */
export function pack(value: Record<string, unknown>): Buffer {
  const json: Record<string, unknown> = { ...value };
  const raw: Buffer[] = [];
  const bin: Array<[string, number]> = [];
  for (const field of BINARY_FIELDS) {
    if (typeof json[field] !== 'string') continue;
    const bytes = Buffer.from(json[field] as string, 'base64');
    delete json[field];
    bin.push([field, bytes.length]);
    raw.push(bytes);
  }
  return frame({ ...json, ...(bin.length ? { $bin: bin } : {}) }, Buffer.concat(raw));
}

export function unpack(bytes: Buffer): Record<string, unknown> {
  const { header, body } = unframe<Record<string, unknown>>(bytes);
  const { $bin, ...value } = header;
  let offset = 0;
  for (const [field, length] of ($bin ?? []) as Array<[string, number]>) {
    value[field] = body.subarray(offset, offset + length).toString('base64');
    offset += length;
  }
  return value;
}

/** Ephemeral-static X25519, HKDF-SHA256, AES-256-GCM. */
function seal(
  plaintext: Buffer,
  recipient: PublicKey,
  aad: Buffer,
): { eph: Buffer; iv: Buffer; ciphertext: Buffer } {
  const ephemeral = generateKeyPairSync('x25519');
  const eph = Buffer.from(ephemeral.publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const key = derive(
    diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient.box }),
    eph,
    recipient.raw,
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { eph, iv, ciphertext };
}

function unseal(
  ciphertext: Buffer,
  eph: Buffer,
  iv: Buffer,
  recipient: KeyPair,
  aad: Buffer,
): Buffer {
  try {
    const key = derive(
      diffieHellman({
        privateKey: recipient.boxPrivate,
        publicKey: importX25519(eph),
      }),
      eph,
      recipient.raw,
    );
    const decipher = createDecipheriv('aes-256-gcm', key, iv).setAAD(aad);
    decipher.setAuthTag(ciphertext.subarray(-16));
    return Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  } catch {
    throw new DeadDropError('DECRYPT_FAILED', 'shell.v2 message could not be decrypted');
  }
}

function derive(shared: Buffer, eph: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(
    hkdfSync('sha256', shared, Buffer.concat([eph, recipient]), 'ddshell/v2 seal', 32),
  );
}

function importX25519(raw: Buffer): KeyObject {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') },
    format: 'jwk',
  });
}

function callFields(header: Omit<CallHeader, 'sig'>): string[] {
  return [header.client, header.host, String(header.ts), header.nonce, header.eph, header.iv];
}

// ------------------------------------------------------------------ controller

/** A sealed request, and the signature its answer must name. */
export function sealCall(
  request: Record<string, unknown>,
  client: KeyPair,
  host: PublicKey,
  now = Date.now(),
): { bytes: Buffer; sig: Buffer } {
  const base = {
    v: 2 as const,
    kind: 'call' as const,
    client: client.fingerprint,
    host: host.fingerprint,
    ts: now,
    nonce: randomBytes(16).toString('base64'),
  };
  const aad = transcript('ddshell/v2/call', base.client, base.host, String(base.ts), base.nonce);
  const { eph, iv, ciphertext } = seal(pack(request), host, aad);
  const header = { ...base, eph: eph.toString('base64'), iv: iv.toString('base64') };
  const sig = sign(
    null,
    transcript('ddshell/v2/call', ...callFields(header), ciphertext),
    client.signPrivate,
  );
  return { bytes: frame({ ...header, sig: sig.toString('base64') }, ciphertext), sig };
}

/** Checks the host's signature, decrypts, and throws the error it carries, if any. */
export function openAnswer<Result>(
  bytes: Uint8Array,
  client: KeyPair,
  host: PublicKey,
  requestSig: Buffer,
): Result {
  const { header, body } = unframe<AnswerHeader>(bytes);
  const valid =
    typeof header.sig === 'string' &&
    verify(
      null,
      transcript('ddshell/v2/answer', requestSig, header.eph, header.iv, body),
      host.sign,
      Buffer.from(header.sig, 'base64'),
    );
  if (!valid) {
    throw new DeadDropError('UNAUTHORIZED', 'answer is not signed by the pinned host key');
  }
  const value = unpack(
    unseal(
      body,
      Buffer.from(header.eph, 'base64'),
      Buffer.from(header.iv, 'base64'),
      client,
      requestSig,
    ),
  );
  if (value.$error) {
    throw DeadDropError.fromJSON(value.$error as Parameters<typeof DeadDropError.fromJSON>[0]);
  }
  return value as Result;
}

export function helloRequest(): { bytes: Buffer; nonce: string } {
  const nonce = randomBytes(16).toString('base64');
  return { bytes: frame({ v: 2, kind: 'hello', nonce } satisfies HelloHeader), nonce };
}

/** The host key a server claims, checked to be held by whoever answered. */
export function openHello(bytes: Uint8Array, peer: string, nonce: string): PublicKey {
  const { header } = unframe<HelloAnswer>(bytes);
  const raw = Buffer.from(String(header.key), 'base64');
  const key = parsePublicKey(`${KEY_TYPE} ${raw.toString('base64')}`);
  const valid = verify(
    null,
    transcript('ddshell/v2/hello', peer, nonce, raw),
    key.sign,
    Buffer.from(String(header.sig), 'base64'),
  );
  if (!valid)
    throw new DeadDropError('UNAUTHORIZED', `${peer} answered hello with a bad signature`);
  return key;
}

// ---------------------------------------------------------------------- server

export type Opened =
  | { kind: 'hello'; nonce: string }
  | { kind: 'call'; client: PublicKey; request: Record<string, unknown>; sig: Buffer };

/**
 * Checks everything that can be checked before anything runs: that the
 * request was sealed to this host, by a key in `authorized`, recently, once.
 */
export async function openRequest(
  bytes: Uint8Array,
  host: KeyPair,
  authorized: (fingerprint: string) => PublicKey | undefined,
  guard: ReplayGuard,
): Promise<Opened> {
  const { header, body } = unframe<CallHeader | HelloHeader>(bytes);
  if (header.v !== 2) throw new DeadDropError('BAD_REQUEST', 'unsupported shell.v2 message');
  if (header.kind === 'hello') {
    if (typeof header.nonce !== 'string')
      throw new DeadDropError('BAD_REQUEST', 'hello needs a nonce');
    return { kind: 'hello', nonce: header.nonce };
  }
  if (header.kind !== 'call') throw new DeadDropError('BAD_REQUEST', 'unknown shell.v2 message');
  const fields = callFields(header);
  if (!fields.every((field) => typeof field === 'string') || !Number.isSafeInteger(header.ts)) {
    throw new DeadDropError('BAD_REQUEST', 'malformed shell.v2 call');
  }
  const client = authorized(header.client);
  if (!client) {
    throw new DeadDropError(
      'UNAUTHORIZED',
      `key ${header.client} is not in this server's shell.authorizedKeys`,
    );
  }
  const valid =
    typeof header.sig === 'string' &&
    verify(
      null,
      transcript('ddshell/v2/call', ...fields, body),
      client.sign,
      Buffer.from(header.sig, 'base64'),
    );
  if (!valid) throw new DeadDropError('UNAUTHORIZED', 'request signature does not verify');
  if (header.host !== host.fingerprint) {
    throw new DeadDropError(
      'UNAUTHORIZED',
      `request was sealed to host key ${header.host}, but this server's key is ${host.fingerprint}`,
    );
  }
  await guard.check(header.ts, header.nonce);
  const aad = transcript(
    'ddshell/v2/call',
    header.client,
    header.host,
    String(header.ts),
    header.nonce,
  );
  const plaintext = unseal(
    body,
    Buffer.from(header.eph, 'base64'),
    Buffer.from(header.iv, 'base64'),
    host,
    aad,
  );
  return {
    kind: 'call',
    client,
    request: unpack(plaintext),
    sig: Buffer.from(header.sig, 'base64'),
  };
}

/** Seals a result, or an error thrown while handling the request, to the caller. */
export function sealAnswer(
  outcome: { result: unknown } | { error: DeadDropError },
  client: PublicKey,
  requestSig: Buffer,
  host: KeyPair,
): Buffer {
  const value =
    'error' in outcome
      ? { $error: outcome.error.toJSON() }
      : ((outcome.result ?? {}) as Record<string, unknown>);
  const { eph, iv, ciphertext } = seal(pack(value), client, requestSig);
  const header = { eph: eph.toString('base64'), iv: iv.toString('base64') };
  const sig = sign(
    null,
    transcript('ddshell/v2/answer', requestSig, header.eph, header.iv, ciphertext),
    host.signPrivate,
  );
  return frame({ ...header, sig: sig.toString('base64') } satisfies AnswerHeader, ciphertext);
}

export function answerHello(host: KeyPair, peer: string, nonce: string): Buffer {
  const sig = sign(null, transcript('ddshell/v2/hello', peer, nonce, host.raw), host.signPrivate);
  return frame({
    key: host.raw.toString('base64'),
    sig: sig.toString('base64'),
  } satisfies HelloAnswer);
}

/**
 * Refuses a request whose timestamp is outside `windowMs` of this clock, or
 * whose nonce was seen before. Seen nonces are appended to `path` before the
 * request runs, so a restart does not reopen the window to a replay.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async open(): Promise<void> {
    let text = '';
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const line of text.split('\n')) {
      const [expiry, nonce] = line.split(' ');
      if (nonce && Number(expiry) > this.now()) this.seen.set(nonce, Number(expiry));
    }
    await this.compact();
  }

  async check(ts: number, nonce: string): Promise<void> {
    const skew = ts - this.now();
    if (Math.abs(skew) > this.windowMs) {
      throw new DeadDropError(
        'UNAUTHORIZED',
        `request is timestamped ${Math.round(skew / 1000)} s from the server's clock, outside the ${Math.round(this.windowMs / 1000)} s replay window; check both clocks`,
      );
    }
    if (this.seen.has(nonce))
      throw new DeadDropError('REPLAY_DETECTED', 'request was already received');
    // Checked and set with no await between, so two copies cannot both pass.
    const expiry = ts + this.windowMs;
    this.seen.set(nonce, expiry);
    await this.write(() => appendFile(this.path, `${expiry} ${nonce}\n`, { mode: 0o600 }));
  }

  /** Forgets expired nonces and rewrites the file with the rest. */
  async compact(): Promise<void> {
    const now = this.now();
    for (const [nonce, expiry] of this.seen) if (expiry <= now) this.seen.delete(nonce);
    await this.write(async () => {
      const temporary = `${this.path}.tmp`;
      const handle = await open(temporary, 'w', 0o600);
      try {
        await handle.writeFile(
          [...this.seen].map(([nonce, expiry]) => `${expiry} ${nonce}\n`).join(''),
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
    });
  }

  /** Appends and rewrites run one at a time, so a rewrite never loses an append. */
  private write(step: () => Promise<void>): Promise<void> {
    const next = this.writes.then(step);
    this.writes = next.catch(() => undefined);
    return next;
  }
}
