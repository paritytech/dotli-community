// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A BitTorrent v1 torrent for the tests: three files that are not piece-aligned, and the bytes of all files.

const encoder = new TextEncoder();
export const toHex = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function sha1(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-1', bytes as Uint8Array<ArrayBuffer>));
}

/** A bencoded multi-file info dict, keys in order. */
function encodeInfo(
  name: string,
  pieceLength: number,
  pieces: Uint8Array,
  files: [string, number][],
): Uint8Array<ArrayBuffer> {
  const str = (value: string | Uint8Array): Uint8Array => {
    const raw = typeof value === 'string' ? encoder.encode(value) : value;
    return concat([encoder.encode(`${String(raw.length)}:`), raw]);
  };
  const int = (n: number): Uint8Array => encoder.encode(`i${String(n)}e`);
  const list = files.map(([path, length]) =>
    concat([
      encoder.encode('d'),
      str('length'),
      int(length),
      str('path'),
      encoder.encode('l'),
      str(path),
      encoder.encode('ee'),
    ]),
  );
  return concat([
    encoder.encode('d'),
    str('files'),
    encoder.encode('l'),
    ...list,
    encoder.encode('e'),
    str('name'),
    str(name),
    str('piece length'),
    int(pieceLength),
    str('pieces'),
    str(pieces),
    encoder.encode('e'),
  ]);
}

/** A torrent of three files that are not piece-aligned, with 64 KiB pieces, and the bytes of all files. */
export async function threeFileTorrent(): Promise<{
  info: Uint8Array<ArrayBuffer>;
  infoHash: string;
  all: Uint8Array<ArrayBuffer>;
  sizes: number[];
}> {
  const sizes = [100_001, 300_007, 50_003];
  const all = Uint8Array.from({ length: sizes.reduce((a, b) => a + b, 0) }, (_, i) => (i * 7 + (i >> 9)) & 0xff);
  const piece = 65_536;
  const hashes: Uint8Array[] = [];
  for (let at = 0; at < all.length; at += piece) {
    hashes.push(await sha1(all.subarray(at, Math.min(at + piece, all.length))));
  }
  const info = encodeInfo(
    'dir',
    piece,
    concat(hashes),
    sizes.map((size, i): [string, number] => [`f${String(i)}.bin`, size]),
  );
  return { info, infoHash: toHex(await sha1(info)), all, sizes };
}
