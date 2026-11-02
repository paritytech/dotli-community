// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { base64urlnopad, utf8 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { isRecord } from '@dotli/shared';
import { createCancelledMessage } from '../sessionHandoff/sessionMessages.js';
import { probeSeal, sealRedirect } from './siteSeal.js';

type Envelope = {
  v: number;
  round: string;
  epk: string;
  iv: string;
  ct: string;
};

type Params = {
  privateKey: CryptoKey;
  envelope: Envelope;
  round: string;
};

const X25519 = { name: 'X25519' } as const;
const MESSAGE = createCancelledMessage('r1');

/** The site's side of one redirect round: its key pair, as the client library keeps it. */
async function generateSiteKeys() {
  const pair = await crypto.subtle.generateKey(X25519, false, ['deriveBits']);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKey };
}

// WebCrypto takes bytes only over a plain ArrayBuffer, which a copy and TextEncoder give.
function decodeBytes(value: string) {
  return Uint8Array.from(base64urlnopad.decode(value));
}

function encodeText(value: string) {
  return new TextEncoder().encode(value);
}

/** Reads the envelope a sealed return address carries in its fragment, and throws when it holds none. */
function readEnvelope(url: string): Envelope {
  const value = new URLSearchParams(new URL(url).hash.slice(1)).get('dotli-s') ?? '';
  const parsed: unknown = JSON.parse(utf8.encode(base64urlnopad.decode(value)));
  if (!isEnvelope(parsed)) {
    throw new Error(`No sealed envelope in ${url}`);
  }
  return parsed;
}

function isEnvelope(value: unknown): value is Envelope {
  return (
    isRecord(value) &&
    typeof value['v'] === 'number' &&
    typeof value['round'] === 'string' &&
    typeof value['epk'] === 'string' &&
    typeof value['iv'] === 'string' &&
    typeof value['ct'] === 'string'
  );
}

/** The client library's opener, from WebCrypto: X25519, HKDF-SHA-256 over the round, AES-256-GCM. */
async function openEnvelope({ privateKey, envelope, round }: Params): Promise<unknown> {
  const ephemeralPublicKey = await crypto.subtle.importKey('raw', decodeBytes(envelope.epk), X25519, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'X25519', public: ephemeralPublicKey }, privateKey, 256);
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encodeText(round), info: encodeText('dotli:s:v1:redirect') },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decodeBytes(envelope.iv), additionalData: encodeText(round) },
    key,
    decodeBytes(envelope.ct),
  );
  return JSON.parse(utf8.encode(new Uint8Array(plaintext)));
}

describe('site seal', () => {
  it('As a site, I open the sealed answer with my key and read the message the window sent', async () => {
    // Given the site's key pair for round r1
    const site = await generateSiteKeys();

    // When the window seals a message to it, and the site opens the envelope the answer carries
    const url = await sealRedirect({
      returnTo: 'https://a.example/back',
      sitePublicKey: site.publicKey,
      round: 'r1',
      message: MESSAGE,
    });
    const envelope = readEnvelope(url);
    const opened = await openEnvelope({ privateKey: site.privateKey, envelope, round: 'r1' });

    // Then the site's opener gives back the message from an envelope of version 1 for that round, which holds the
    // library's fields alone, a 32-byte ephemeral key and a 12-byte IV
    expect(Object.keys(envelope)).toEqual(['v', 'round', 'epk', 'iv', 'ct']);
    expect({ v: envelope.v, round: envelope.round }).toEqual({ v: 1, round: 'r1' });
    expect(decodeBytes(envelope.epk)).toHaveLength(32);
    expect(decodeBytes(envelope.iv)).toHaveLength(12);
    expect(opened).toEqual(MESSAGE);
  });

  it('As a site, I open an answer sealed for one round with another round id and decryption fails', async () => {
    // Given an answer sealed for round r1
    const site = await generateSiteKeys();
    const envelope = readEnvelope(
      await sealRedirect({
        returnTo: 'https://a.example/back',
        sitePublicKey: site.publicKey,
        round: 'r1',
        message: MESSAGE,
      }),
    );

    // When the site opens it as round r2
    const opened = openEnvelope({ privateKey: site.privateKey, envelope, round: 'r2' });

    // Then the decryption fails
    await expect(opened).rejects.toThrow();
  });

  it('As a site, I get my return address back with its path and query and the answer only in the fragment', async () => {
    // Given the site's key pair
    const site = await generateSiteKeys();

    // When the window seals to a return address with a path and query
    const url = new URL(
      await sealRedirect({
        returnTo: 'https://a.example/back/here?x=1&y=2',
        sitePublicKey: site.publicKey,
        round: 'r1',
        message: MESSAGE,
      }),
    );

    // Then only the fragment is set
    expect({ origin: url.origin, pathname: url.pathname, search: url.search }).toEqual({
      origin: 'https://a.example',
      pathname: '/back/here',
      search: '?x=1&y=2',
    });
    expect(url.hash).toMatch(/^#dotli-s=[A-Za-z0-9_-]+$/);
  });

  it('As a site, I send a valid key and the probe says the window can seal to it', async () => {
    // Given the site's key pair
    const site = await generateSiteKeys();

    // When the window probes sealing
    const probe = await probeSeal(site.publicKey);

    // Then sealing works
    expect(probe).toBe('ok');
  });

  it('As a user of a browser without X25519, I start a redirect sign-in and the probe says unsupported', async () => {
    // Given a crypto whose X25519 key generation fails
    const failingGenerateKey = () =>
      Promise.reject(new DOMException('Unrecognized algorithm name', 'NotSupportedError'));
    const subtle = new Proxy(crypto.subtle, {
      get: (target, key): unknown => (key === 'generateKey' ? failingGenerateKey : Reflect.get(target, key, target)),
    });
    const withoutX25519 = new Proxy(crypto, {
      get: (target, key): unknown => (key === 'subtle' ? subtle : Reflect.get(target, key, target)),
    });
    const site = await generateSiteKeys();

    // When the window probes sealing with it
    const probe = await probeSeal(site.publicKey, { crypto: withoutX25519 });

    // Then the browser is unsupported
    expect(probe).toBe('unsupported');
  });

  it.each([
    { name: 'all zero', key: new Uint8Array(32) },
    { name: '31 bytes long', key: new Uint8Array(31).fill(9) },
  ])('As a site, I send a key that is $name and the probe says it is a bad key', async ({ key }) => {
    // Given a key no shared secret can be derived with
    const sitePublicKey = key;

    // When the window probes sealing
    const probe = await probeSeal(sitePublicKey);

    // Then the key is bad
    expect(probe).toBe('bad_key');
  });
});
