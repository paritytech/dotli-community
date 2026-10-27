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

const SALT_LENGTH = 16;
const NONCE_LENGTH = 12;
const KEY_LENGTH = 32;
const TAG_LENGTH = 16;
const HEADER_LENGTH = MAGIC.length + SALT_LENGTH + NONCE_LENGTH;
const PBKDF2_ITERATIONS = 100_000;

/** Tells whether the bytes start with the encrypted-archive header and are long enough to hold a tag. Never throws. */
export function isEncrypted(data: Uint8Array): boolean {
  if (data.length < HEADER_LENGTH + TAG_LENGTH) {
    return false;
  }
  for (let index = 0; index < MAGIC.length; index++) {
    if (data[index] !== MAGIC[index]) {
      return false;
    }
  }
  return true;
}

/** Throws on a wrong password or corrupted data. */
export async function decryptContent(data: Uint8Array, password: string): Promise<Uint8Array> {
  const salt = data.slice(MAGIC.length, MAGIC.length + SALT_LENGTH);
  const nonce = data.slice(MAGIC.length + SALT_LENGTH, HEADER_LENGTH);
  const ciphertext = data.slice(HEADER_LENGTH);

  const key = await deriveKey(password, salt);
  const aead = chacha20poly1305(key, nonce, MAGIC);
  return aead.decrypt(ciphertext);
}

async function deriveKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password).buffer, 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      // The salt is sliced into its own buffer, never a SharedArrayBuffer, which the typing of `buffer` cannot tell.
      salt: salt.buffer as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    KEY_LENGTH * 8,
  );
  return new Uint8Array(bits);
}
