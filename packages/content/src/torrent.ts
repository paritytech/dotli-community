// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// BitTorrent v1 for reads of torrent files through cache nodes (`Preimage.readTorrent`). A cache node keeps one file of a
// torrent under the content id `bt:<infohash in hex>:<file>`, and sends its span: the pieces that hold the file. In v1 a
// piece can hold the end of one file and the start of the next, so a span can have bytes of other files at its ends.
// The user agent checks the SHA-1 of the info dict against the infohash, and the SHA-1 of each piece against the info
// dict, before it pays. The cache (cache/src/torrent.rs) has the same rules.

const decoder = new TextDecoder();

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The torrent and the file that a magnet link names. */
export interface MagnetRef {
  /** The v1 infohash: 40 lowercase hex digits. */
  infoHash: string;
  /** The file of `so=`, when the link selects one. */
  file?: number;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function base32ToHex(text: string): string {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.toUpperCase()) {
    const digit = BASE32.indexOf(char);
    if (digit < 0) {
      throw new Error(`btih ${text} is not base32`);
    }
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return toHex(Uint8Array.from(out));
}

/** The infohash and the selected file of a magnet link. Only BitTorrent v1 (`btih`) is supported. */
export function parseMagnet(magnet: string): MagnetRef {
  if (!magnet.startsWith('magnet:?')) {
    throw new Error('not a magnet link: it starts with magnet:?');
  }
  const params = new URLSearchParams(magnet.slice('magnet:?'.length));
  const btih = params
    .getAll('xt')
    .find(xt => xt.startsWith('urn:btih:'))
    ?.slice('urn:btih:'.length);
  if (btih === undefined) {
    throw new Error(
      params.getAll('xt').some(xt => xt.startsWith('urn:btmh:'))
        ? 'BitTorrent v2-only torrents are not supported: the magnet link needs a btih'
        : 'the magnet link has no xt=urn:btih:',
    );
  }
  let infoHash: string;
  if (/^[0-9a-fA-F]{40}$/.test(btih)) {
    infoHash = btih.toLowerCase();
  } else if (btih.length === 32) {
    infoHash = base32ToHex(btih);
  } else {
    throw new Error(`btih ${btih} is not 40 hex digits or 32 base32 characters`);
  }
  const selected = params.getAll('so');
  if (selected.length === 0) {
    return { infoHash };
  }
  if (selected.length > 1 || !/^\d+$/.test(selected[0] ?? '')) {
    throw new Error('the magnet link must select exactly one file, for example so=2');
  }
  return { infoHash, file: Number(selected[0]) };
}

/** The content id of one file of a torrent at a cache node. */
export function torrentId(infoHash: string, file: number): string {
  return `bt:${infoHash}:${String(file)}`;
}

type Bencode = number | Uint8Array | Bencode[] | Map<string, Bencode>;

// A bencode value at `at`, and the position after it.
function decode(bytes: Uint8Array, at: number): [Bencode, number] {
  const char = bytes[at];
  if (char === 0x69) {
    // i<digits>e
    const end = bytes.indexOf(0x65, at);
    return [Number(decoder.decode(bytes.subarray(at + 1, end))), end + 1];
  }
  if (char === 0x6c || char === 0x64) {
    // l…e or d…e
    const list: Bencode[] = [];
    const dict = new Map<string, Bencode>();
    let next = at + 1;
    while (bytes[next] !== 0x65) {
      if (next >= bytes.length) {
        throw new Error('the info dict ends early');
      }
      if (char === 0x6c) {
        const [item, after] = decode(bytes, next);
        list.push(item);
        next = after;
      } else {
        const [key, afterKey] = decode(bytes, next);
        const [item, after] = decode(bytes, afterKey);
        if (!(key instanceof Uint8Array)) {
          throw new Error('a key of the info dict is not a string');
        }
        dict.set(decoder.decode(key), item);
        next = after;
      }
    }
    return [char === 0x6c ? list : dict, next + 1];
  }
  // <length>:<bytes>
  const colon = bytes.indexOf(0x3a, at);
  if (colon < 0 || char === undefined || char < 0x30 || char > 0x39) {
    throw new Error('the info dict is not bencode');
  }
  const length = Number(decoder.decode(bytes.subarray(at, colon)));
  return [bytes.subarray(colon + 1, colon + 1 + length), colon + 1 + length];
}

/** One file of a torrent. `offset` is its position in the bytes of all files. */
export interface TorrentFile {
  path: string;
  length: number;
  offset: number;
  padding: boolean;
}

/** The parts of an info dict that a check of a span needs. */
export interface TorrentInfo {
  name: string;
  pieceLength: number;
  pieces: Uint8Array;
  files: TorrentFile[];
  total: number;
}

function text(value: Bencode | undefined): string {
  return value instanceof Uint8Array ? decoder.decode(value) : '';
}

/** Parse the info dict of a torrent: the bytes whose SHA-1 is the infohash. */
export function parseInfo(info: Uint8Array): TorrentInfo {
  const [root] = decode(info, 0);
  if (!(root instanceof Map)) {
    throw new Error('the info dict is not a dictionary');
  }
  const pieceLength = root.get('piece length');
  const pieces = root.get('pieces');
  if (typeof pieceLength !== 'number' || pieceLength <= 0 || !(pieces instanceof Uint8Array)) {
    throw new Error('the info dict has no piece length or pieces');
  }
  if (root.get('private') === 1) {
    throw new Error('private torrents are not supported');
  }
  const name = text(root.get('name'));
  const files: TorrentFile[] = [];
  let offset = 0;
  const list = root.get('files');
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (!(entry instanceof Map) || typeof entry.get('length') !== 'number') {
        throw new Error('a file of the info dict has no length');
      }
      const length = entry.get('length') as number;
      const parts = entry.get('path');
      const path = Array.isArray(parts) ? parts.map(part => text(part)).join('/') : '';
      files.push({ path, length, offset, padding: text(entry.get('attr')).includes('p') });
      offset += length;
    }
  } else if (typeof root.get('length') === 'number') {
    const length = root.get('length') as number;
    files.push({ path: name, length, offset: 0, padding: false });
    offset = length;
  } else {
    throw new Error('the info dict has no files');
  }
  return { name, pieceLength, pieces, files, total: offset };
}

/** The pieces that hold file `file`: their range in the bytes of all files, and the range of the file in them. */
export function spanOf(
  info: TorrentInfo,
  file: number,
): { start: number; end: number; fileStart: number; fileEnd: number } {
  const selected = info.files[file];
  if (selected === undefined || selected.padding) {
    throw new Error(`the torrent has no file ${String(file)}`);
  }
  if (selected.length === 0) {
    return { start: selected.offset, end: selected.offset, fileStart: 0, fileEnd: 0 };
  }
  const piece = info.pieceLength;
  const start = Math.floor(selected.offset / piece) * piece;
  const end = Math.min(Math.ceil((selected.offset + selected.length) / piece) * piece, info.total);
  const fileStart = selected.offset - start;
  return { start, end, fileStart, fileEnd: fileStart + selected.length };
}

async function sha1(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-1', bytes as Uint8Array<ArrayBuffer>));
}

/**
 * Check a span from a cache node against a torrent, and give the file in it. `info` is the info dict: its SHA-1 must be
 * the infohash. Each piece of the span must have the SHA-1 that the info dict gives.
 */
export async function verifySpan(
  info: Uint8Array,
  infoHash: string,
  file: number,
  span: Uint8Array,
): Promise<{ value: Uint8Array; name: string }> {
  if (toHex(await sha1(info)) !== infoHash) {
    throw new Error(`the info dict is not the one of ${infoHash}`);
  }
  const parsed = parseInfo(info);
  const range = spanOf(parsed, file);
  if (span.length !== range.end - range.start) {
    throw new Error(
      `${String(span.length)} bytes are not the ${String(range.end - range.start)} bytes of the pieces of file ${String(file)}`,
    );
  }
  const first = range.start / parsed.pieceLength;
  for (let at = 0, index = first; at < span.length; at += parsed.pieceLength, index++) {
    const digest = await sha1(span.subarray(at, Math.min(at + parsed.pieceLength, span.length)));
    const expected = parsed.pieces.subarray(index * 20, index * 20 + 20);
    if (toHex(digest) !== toHex(expected)) {
      throw new Error(`piece ${String(index)} does not have the hash of the torrent`);
    }
  }
  const name = parsed.files.length > 1 ? `${parsed.name}/${parsed.files[file]?.path ?? ''}` : parsed.name;
  return { value: span.slice(range.fileStart, range.fileEnd), name };
}
