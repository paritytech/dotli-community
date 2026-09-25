// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Seity encrypted-blob references: `"<cid>#<keyHex><ivHex>"`.
//
// The format is pinned by Seity's profile-core (`blob.ts`): the CID is a
// CIDv1 raw/Blake2b-256 address of AES-256-GCM ciphertext on Bulletin, and the
// fragment carries the 32-byte key followed by the 12-byte IV, hex-encoded.
// profile-core is not published as a package dotli can depend on, so the two
// operations the host needs live here and are pinned against a vector produced
// with profile-core's own primitives (see the test).
//
// The reference is a bearer capability. It is parsed and used here, in the
// host, and never logged or handed back to the product.

import { cidToPreimageKey } from "@dotli/content/preimage";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const FRAGMENT_PATTERN = new RegExp(
  `^[0-9a-fA-F]{${String((KEY_BYTES + IV_BYTES) * 2)}}$`,
);

export interface SeityBlobReference {
  /** Blake2b-256 preimage key the ciphertext is stored under. */
  readonly preimageKey: `0x${string}`;
  readonly aesKey: Uint8Array<ArrayBuffer>;
  readonly iv: Uint8Array<ArrayBuffer>;
}

export class InvalidProfileReferenceError extends Error {
  constructor(reason: string) {
    // The reference itself stays out of the message: it is a capability.
    super(`invalid profile reference: ${reason}`);
    this.name = "InvalidProfileReferenceError";
  }
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function parseSeityBlobReference(reference: string): SeityBlobReference {
  const hash = reference.indexOf("#");
  if (hash < 1 || hash !== reference.lastIndexOf("#")) {
    throw new InvalidProfileReferenceError("expected <cid>#<key><iv>");
  }
  const fragment = reference.slice(hash + 1);
  if (!FRAGMENT_PATTERN.test(fragment)) {
    throw new InvalidProfileReferenceError(
      "fragment must be a 32-byte key and 12-byte IV in hex",
    );
  }
  let preimageKey: `0x${string}`;
  try {
    preimageKey = cidToPreimageKey(reference.slice(0, hash));
  } catch {
    throw new InvalidProfileReferenceError(
      "CID must be a raw Blake2b-256 CIDv1",
    );
  }
  return {
    preimageKey,
    aesKey: hexBytes(fragment.slice(0, KEY_BYTES * 2)),
    iv: hexBytes(fragment.slice(KEY_BYTES * 2)),
  };
}

/**
 * Decrypt a fetched blob. AES-GCM authenticates, so a wrong key, IV or
 * substituted ciphertext rejects rather than yielding bytes.
 */
export async function openSeityBlob(
  ciphertext: Uint8Array<ArrayBuffer>,
  reference: Pick<SeityBlobReference, "aesKey" | "iv">,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    reference.aesKey,
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: reference.iv },
    key,
    ciphertext,
  );
  return new Uint8Array(plaintext);
}
