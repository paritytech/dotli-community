// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { isEncrypted, decryptContent } from "@dotli/content/decrypt";

const MAGIC = new Uint8Array([
  0x44, 0x4f, 0x54, 0x4c, 0x49, 0x5f, 0x45, 0x4e, 0x43, 0x01,
]);
const SALT_LEN = 16;
const NONCE_LEN = 12;
const KEY_LEN = 32;
const PBKDF2_ITERATIONS = 100_000;

/** Encrypt a payload with the same format decrypt.ts expects. */
async function encrypt(
  plaintext: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));

  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password).buffer,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const keyBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt.buffer as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    KEY_LEN * 8,
  );
  const key = new Uint8Array(keyBits);

  const aead = chacha20poly1305(key, nonce, MAGIC);
  const ciphertext = aead.encrypt(plaintext);

  const result = new Uint8Array(
    MAGIC.length + SALT_LEN + NONCE_LEN + ciphertext.length,
  );
  result.set(MAGIC, 0);
  result.set(salt, MAGIC.length);
  result.set(nonce, MAGIC.length + SALT_LEN);
  result.set(ciphertext, MAGIC.length + SALT_LEN + NONCE_LEN);
  return result;
}

describe("isEncrypted", () => {
  it("returns false for empty buffer", () => {
    expect(isEncrypted(new Uint8Array(0))).toBe(false);
  });

  it("returns false for small buffer", () => {
    expect(isEncrypted(new Uint8Array(30))).toBe(false);
  });

  it("returns false for random data", () => {
    const random = new Uint8Array(128);
    crypto.getRandomValues(random);
    expect(isEncrypted(random)).toBe(false);
  });

  it("returns false for plain HTML", () => {
    const html = new TextEncoder().encode("<html><body>Hello</body></html>");
    expect(isEncrypted(html)).toBe(false);
  });

  it("returns true for data with magic header", async () => {
    const encrypted = await encrypt(new TextEncoder().encode("hello"), "test");
    expect(isEncrypted(encrypted)).toBe(true);
  });
});

describe("decryptContent", () => {
  it("round-trips encrypt → decrypt", async () => {
    const original = new TextEncoder().encode(
      "<html><body>Secret SPA</body></html>",
    );
    const encrypted = await encrypt(original, "my-password");
    const decrypted = await decryptContent(encrypted, "my-password");
    expect(decrypted).toEqual(original);
  });

  it("rejects wrong password", async () => {
    const encrypted = await encrypt(
      new TextEncoder().encode("secret"),
      "correct",
    );
    await expect(decryptContent(encrypted, "wrong")).rejects.toThrow();
  });

  it("handles binary content (archive blob)", async () => {
    const binary = new Uint8Array(1024);
    crypto.getRandomValues(binary);
    const encrypted = await encrypt(binary, "pass123");
    const decrypted = await decryptContent(encrypted, "pass123");
    expect(decrypted).toEqual(binary);
  });
});
