// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Layout written by external tooling: magic, salt, nonce, then ciphertext with its Poly1305 tag.
// ChaCha20-Poly1305 comes from @noble/ciphers because Web Crypto lacks it.

import { chacha20poly1305 } from '@noble/ciphers/chacha.js';

const MAGIC = new Uint8Array([
  0x44,
  0x4f,
  0x54,
  0x4c,
  0x49,
  0x5f,
  0x45,
  0x4e,
  0x43,
  0x01, // "DOTLI_ENC\x01"
]);

const SALT_LEN = 16;
const NONCE_LEN = 12;
const KEY_LEN = 32;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + SALT_LEN + NONCE_LEN;
const PBKDF2_ITERATIONS = 100_000;

export function isEncrypted(data: Uint8Array): boolean {
  if (data.length < HEADER_LEN + TAG_LEN) {
    return false;
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (data[i] !== MAGIC[i]) {
      return false;
    }
  }
  return true;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password).buffer, 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt.buffer as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    KEY_LEN * 8,
  );
  return new Uint8Array(bits);
}

/** Throws on a wrong password or corrupted data. */
export async function decryptContent(data: Uint8Array, password: string): Promise<Uint8Array> {
  const salt = data.slice(MAGIC.length, MAGIC.length + SALT_LEN);
  const nonce = data.slice(MAGIC.length + SALT_LEN, HEADER_LEN);
  const ciphertext = data.slice(HEADER_LEN);

  const key = await deriveKey(password, salt);
  const aead = chacha20poly1305(key, nonce, MAGIC);
  return aead.decrypt(ciphertext);
}
