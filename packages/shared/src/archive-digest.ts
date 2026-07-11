// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Deterministic integrity digest over a map of files (path -> bytes).
//
// Used by the sandbox Service Worker to tag persisted archives so a
// corrupted or tampered IndexedDB entry is detected on read instead of
// served. It is an integrity tag, not an authenticity proof: an attacker
// who can rewrite the store can also rewrite the tag, so it defends against
// storage corruption and passive tampering, not an active same-origin
// adversary.

import { toHex } from "./hex";

/**
 * Deterministic SHA-256 digest over a file map. For each file (in
 * sorted-path order) the manifest holds SHA-256(path) ++ SHA-256(bytes):
 * two fixed 32-byte hashes, so the result is independent of object key
 * order and has no delimiter for a crafted path to collide on. Bounded
 * memory — two hashes per file, not the file bytes. Returns lowercase hex.
 */
export async function computeArchiveDigest(
  files: Record<string, BufferSource>,
): Promise<string> {
  const paths = Object.keys(files).sort();
  const enc = new TextEncoder();
  // Per-file hashes are independent — compute them concurrently, then
  // assemble the manifest in sorted-path order so the result stays stable.
  const pairs = await Promise.all(
    paths.map(
      async (p): Promise<[Uint8Array, Uint8Array]> => [
        new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(p))),
        new Uint8Array(await crypto.subtle.digest("SHA-256", files[p])),
      ],
    ),
  );
  const manifest = new Uint8Array(paths.length * 64);
  pairs.forEach(([pathHash, fileHash], i) => {
    manifest.set(pathHash, i * 64);
    manifest.set(fileHash, i * 64 + 32);
  });
  const digest = await crypto.subtle.digest("SHA-256", manifest);
  return toHex(new Uint8Array(digest)).slice(2);
}
