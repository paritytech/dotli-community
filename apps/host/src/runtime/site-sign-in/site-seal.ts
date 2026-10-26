// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Seals a redirect sign-in's answer to the site's temporary key, so it can travel in the return address's fragment.
 * The envelope is the one the site's client library opens: X25519 between a fresh key of the window and the site's
 * key, HKDF-SHA-256 with the round id as salt to an AES-256-GCM key, and the round id as associated data, so an answer
 * opens only for the round it was sealed for.
 */

import { base64urlnopad } from '@scure/base';

import { PROTOCOL_VERSION } from '../session-handoff/session-protocol.js';

const X25519 = { name: 'X25519' } as const;
const HKDF_INFO = utf8('dotli:s:v1:redirect');
const RESULT_KEY = 'dotli-s';
const IV_BYTES = 12;

type SealProbe = 'ok' | 'unsupported' | 'bad_key';

/**
 * Whether this browser can seal to `sitePublicKey`, checked before the round so a sealing failure never strands a
 * signed answer.
 */
export async function sealProbe(sitePublicKey: Uint8Array, deps: { crypto?: Crypto } = {}): Promise<SealProbe> {
  const { subtle } = deps.crypto ?? crypto;
  let ephemeral: CryptoKeyPair;
  try {
    ephemeral = await ephemeralKeyPair(subtle);
  } catch {
    // A browser without X25519 is a verdict the caller shows and counts, not a failure to report.
    return 'unsupported';
  }
  try {
    await sharedSecret(subtle, ephemeral.privateKey, sitePublicKey);
    return 'ok';
  } catch {
    // A key of the wrong length or of small order is the site's bad request, not a failure to report.
    return 'bad_key';
  }
}

/** Seals `message` for `round` to `sitePublicKey` and returns `returnTo` with the envelope as its fragment. */
export async function sealRedirect(
  returnTo: string,
  sitePublicKey: Uint8Array,
  round: string,
  message: unknown,
  deps: { crypto?: Crypto } = {},
): Promise<string> {
  const random = deps.crypto ?? crypto;
  const { subtle } = random;
  const ephemeral = await ephemeralKeyPair(subtle);
  const epk = new Uint8Array(await subtle.exportKey('raw', ephemeral.publicKey));
  const key = await aesKey(subtle, ephemeral.privateKey, sitePublicKey, round);
  const iv = random.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(round) }, key, utf8(JSON.stringify(message))),
  );
  const envelope = {
    v: PROTOCOL_VERSION,
    round,
    epk: base64urlnopad.encode(epk),
    iv: base64urlnopad.encode(iv),
    ct: base64urlnopad.encode(ct),
  };
  const url = new URL(returnTo);
  url.hash = `${RESULT_KEY}=${base64urlnopad.encode(utf8(JSON.stringify(envelope)))}`;
  return url.href;
}

// The private key never leaves the browser's key store.
async function ephemeralKeyPair(subtle: SubtleCrypto): Promise<CryptoKeyPair> {
  return subtle.generateKey(X25519, false, ['deriveBits']);
}

async function sharedSecret(subtle: SubtleCrypto, privateKey: CryptoKey, peerPublic: Uint8Array): Promise<ArrayBuffer> {
  // A copy, since WebCrypto takes bytes only over a plain ArrayBuffer.
  const peer = await subtle.importKey('raw', Uint8Array.from(peerPublic), X25519, false, []);
  return subtle.deriveBits({ name: 'X25519', public: peer }, privateKey, 256);
}

async function aesKey(
  subtle: SubtleCrypto,
  privateKey: CryptoKey,
  peerPublic: Uint8Array,
  round: string,
): Promise<CryptoKey> {
  const hkdf = await subtle.importKey('raw', await sharedSecret(subtle, privateKey, peerPublic), 'HKDF', false, [
    'deriveKey',
  ]);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8(round), info: HKDF_INFO },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
}

// TextEncoder's bytes sit over a plain ArrayBuffer, which WebCrypto's types require.
function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}
