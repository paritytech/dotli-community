// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li password-based decryption for encrypted SPAs.
//
// Encrypted format (produced by external tooling):
//   [10 bytes magic "DOTLI_ENC\x01"] [16 bytes salt] [12 bytes nonce] [ciphertext and Poly1305 tag]
//
// Key derivation: PBKDF2-SHA256 (100k iterations) over password and salt yields a 32-byte ChaCha20 key.
// AEAD: ChaCha20-Poly1305 via @noble/ciphers, since Web Crypto does not support it natively.

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

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
const HEADER_LEN = MAGIC.length + SALT_LEN + NONCE_LEN; // 38
const PBKDF2_ITERATIONS = 100_000;

/**
 * Check whether raw bytes start with the encrypted SPA magic header.
 */
export function isEncrypted(data: Uint8Array): boolean {
  if (data.length < HEADER_LEN + TAG_LEN) {
    // Too small to hold the header and at least the Poly1305 tag.
    return false;
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (data[i] !== MAGIC[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Derive a 32-byte ChaCha20 key from a password and salt via PBKDF2-SHA256.
 */
async function deriveKey(
  password: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password).buffer,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt.buffer as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    KEY_LEN * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Decrypt an encrypted SPA blob. Throws on wrong password or corrupted data.
 */
export async function decryptContent(
  data: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  const salt = data.slice(MAGIC.length, MAGIC.length + SALT_LEN);
  const nonce = data.slice(MAGIC.length + SALT_LEN, HEADER_LEN);
  const ciphertext = data.slice(HEADER_LEN);

  const key = await deriveKey(password, salt);
  const aead = chacha20poly1305(key, nonce, MAGIC);
  return aead.decrypt(ciphertext);
}
