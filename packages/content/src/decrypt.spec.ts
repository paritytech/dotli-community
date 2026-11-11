// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { isEncrypted, decryptContent } from './decrypt.js';
import { CONTENT_ERRORS } from './errors.js';

const MAGIC = new Uint8Array([0x44, 0x4f, 0x54, 0x4c, 0x49, 0x5f, 0x45, 0x4e, 0x43, 0x01]);
const SALT_LENGTH = 16;
const NONCE_LENGTH = 12;
const KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;

/** Encrypts `plaintext` under `password` in the layout external tooling writes. */
async function encrypt(plaintext: Uint8Array, password: string): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password).buffer, 'PBKDF2', false, [
    'deriveBits',
  ]);
  const keyBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt.buffer,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    KEY_LENGTH * 8,
  );
  const key = new Uint8Array(keyBits);

  const aead = chacha20poly1305(key, nonce, MAGIC);
  const ciphertext = aead.encrypt(plaintext);

  const result = new Uint8Array(MAGIC.length + SALT_LENGTH + NONCE_LENGTH + ciphertext.length);
  result.set(MAGIC, 0);
  result.set(salt, MAGIC.length);
  result.set(nonce, MAGIC.length + SALT_LENGTH);
  result.set(ciphertext, MAGIC.length + SALT_LENGTH + NONCE_LENGTH);
  return result;
}

describe('isEncrypted', () => {
  it.each([
    { shape: 'empty', content: new Uint8Array(0) },
    { shape: 'too short for the encryption header', content: new Uint8Array(30) },
    { shape: 'random bytes', content: crypto.getRandomValues(new Uint8Array(128)) },
    { shape: 'plain HTML', content: new TextEncoder().encode('<html><body>Hello</body></html>') },
  ])('As a visitor, I open a product whose content is $shape and am not asked for a password', ({ content }) => {
    // Given content of this shape

    // When
    const encrypted = isEncrypted(content);

    // Then
    expect(encrypted).toBe(false);
  });

  it('As a visitor, I open a product whose content sits behind the encryption header and am asked for a password', async () => {
    // Given
    const content = await encrypt(new TextEncoder().encode('hello'), 'test');

    // When
    const encrypted = isEncrypted(content);

    // Then
    expect(encrypted).toBe(true);
  });
});

describe('decryptContent', () => {
  it('As a visitor of an encrypted product, I enter the right password and get the page it was encrypted from', async () => {
    // Given
    const original = new TextEncoder().encode('<html><body>Secret SPA</body></html>');
    const encrypted = await encrypt(original, 'my-password');

    // When
    const decrypted = await decryptContent(encrypted, 'my-password');

    // Then
    expect(decrypted).toEqual(original);
  });

  it('As a visitor of an encrypted product, I enter a wrong password and the decryption fails', async () => {
    // Given
    const encrypted = await encrypt(new TextEncoder().encode('secret'), 'correct');

    // When
    const decrypted = decryptContent(encrypted, 'wrong');

    // Then
    await expect(decrypted).rejects.toHaveProperty('name', CONTENT_ERRORS.WRONG_PASSWORD);
    await expect(decrypted).rejects.toHaveProperty('cause');
  });
});
