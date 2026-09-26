// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Seity contacts references: `"seity-contacts:v1:<lookupKey><seed>"`.
//
// Unlike a `cid#key` blob reference, this names a registry slot rather than a
// blob, so it stays the same while the profile behind it changes. Resolving it
// takes one registry read (raw contract storage, no runtime call), one
// preimage fetch of the sealed record, one AES-GCM open, and then the record's
// avatar is an ordinary blob reference fetched the same way.
//
// Format and seal are pinned by Seity's profile-core (`contacts.ts`) and its
// committed vector. The reference is a bearer capability: parsed and used
// here, never logged or handed back to the product.

import { InvalidProfileReferenceError } from "./seity-reference";

export const CONTACTS_REFERENCE_PREFIX = "seity-contacts:v1:";
const BODY_PATTERN = /^[0-9a-f]{128}$/;
const NONCE_BYTES = 12;

export interface SeityContactsReference {
  /** Registry lookup key, public. */
  readonly lookupKey: `0x${string}`;
  /** AES-256-GCM key for the sealed record. */
  readonly seed: Uint8Array<ArrayBuffer>;
}

export function isContactsReference(reference: string): boolean {
  return reference.startsWith(CONTACTS_REFERENCE_PREFIX);
}

export function parseContactsReference(
  reference: string,
): SeityContactsReference {
  const body = reference.slice(CONTACTS_REFERENCE_PREFIX.length);
  if (!isContactsReference(reference) || !BODY_PATTERN.test(body)) {
    throw new InvalidProfileReferenceError(
      "expected seity-contacts:v1:<32-byte lookup key><32-byte seed>",
    );
  }
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    seed[i] = Number.parseInt(body.slice(64 + i * 2, 66 + i * 2), 16);
  }
  return { lookupKey: `0x${body.slice(0, 64)}`, seed };
}

/**
 * Open a sealed record: `nonce(12) ‖ ciphertext ‖ tag`. AES-GCM
 * authenticates, so the wrong seed or substituted bytes reject.
 */
export async function openContactsRecord(
  sealed: Uint8Array<ArrayBuffer>,
  reference: Pick<SeityContactsReference, "seed">,
): Promise<Uint8Array> {
  if (sealed.length <= NONCE_BYTES) {
    throw new Error("sealed profile record is truncated");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    reference.seed,
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: sealed.slice(0, NONCE_BYTES) },
    key,
    sealed.slice(NONCE_BYTES),
  );
  return new Uint8Array(plaintext);
}
