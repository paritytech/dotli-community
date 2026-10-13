// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import * as dagPb from '@ipld/dag-pb';
import { UnixFS } from 'ipfs-unixfs';
import { CID } from 'multiformats/cid';
import { create } from 'multiformats/hashes/digest';
import { isCarFile, packArchive, parseIpfsResponse, walkUnixFsDag } from './archive.js';
import type { ArchiveFiles, BlockSource } from './archive.js';

describe('isCarFile', () => {
  it('As a sandbox loading a product, I get an empty response and do not read it as a CAR archive', () => {
    // When / Then
    expect(isCarFile(new Uint8Array(0))).toBe(false);
  });

  it('As a sandbox loading a product, I get a response under 10 bytes and do not read it as a CAR archive', () => {
    // When / Then
    expect(isCarFile(new Uint8Array(9))).toBe(false);
  });

  it('As a sandbox loading a product, I get random bytes and do not read them as a CAR archive', () => {
    // Given
    const random = new Uint8Array(64);
    crypto.getRandomValues(random);

    // When / Then
    expect(isCarFile(random)).toBe(false);
  });

  it('As a sandbox loading a product, I get a valid CAR v1 header and read it as a CAR archive', () => {
    // Given
    const header = new Uint8Array([
      0x33, // varint header length = 51
      0xa2, // CBOR: map(2)
      0x65, // CBOR: text(5)
      0x72,
      0x6f,
      0x6f,
      0x74,
      0x73, // "roots"
      0x81, // CBOR: array(1)
      0xd8,
      0x2a, // CBOR: tag(42)
      // Padding up to the 52 bytes the length claims.
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    ]);

    // When / Then
    expect(isCarFile(header)).toBe(true);
  });

  it('As a sandbox loading a product, I get an HTML page and do not read it as a CAR archive', () => {
    // Given
    const html = new TextEncoder().encode('<!DOCTYPE html><html>');

    // When / Then
    expect(isCarFile(html)).toBe(false);
  });
});

describe('packArchive', () => {
  it('As a host handing a product to its sandbox, I pack no files and get an empty archive', () => {
    // When
    const result = packArchive({});

    // Then
    expect(result.packed.byteLength).toBe(0);
    expect(result.index).toEqual([]);
  });

  it('As a host handing a product to its sandbox, I pack one file and its index entry spans its bytes', () => {
    // Given
    const files: ArchiveFiles = {
      'index.html': new TextEncoder().encode('<h1>Hello</h1>'),
    };

    // When
    const result = packArchive(files);

    // Then
    expect(result.index).toHaveLength(1);
    expect(result.index[0]?.p).toBe('index.html');
    expect(result.index[0]?.o).toBe(0);
    expect(result.index[0]?.l).toBe(14);
    expect(result.packed.byteLength).toBe(14);
  });

  it('As a host handing a product to its sandbox, I pack several files and each index entry starts where the last ended', () => {
    // Given
    const files: ArchiveFiles = {
      'index.html': new TextEncoder().encode('<h1>A</h1>'),
      'style.css': new TextEncoder().encode('body{}'),
      'app.js': new TextEncoder().encode('console.log()'),
    };

    // When
    const result = packArchive(files);

    // Then
    expect(result.index).toHaveLength(3);

    let expectedOffset = 0;
    for (const entry of result.index) {
      expect(entry.o).toBe(expectedOffset);
      expectedOffset += entry.l;
    }

    const totalSize = Object.values(files).reduce((sum, data) => sum + data.byteLength, 0);
    expect(result.packed.byteLength).toBe(totalSize);
  });

  it('As a sandbox unpacking a product, I read a packed file back at its index entry and get its content', () => {
    // Given
    const content = 'Hello, World!';
    const files: ArchiveFiles = {
      'test.txt': new TextEncoder().encode(content),
    };

    // When
    const result = packArchive(files);

    // Then
    const view = new Uint8Array(result.packed);
    const [entry] = result.index;
    if (entry === undefined) {
      throw new Error('expected an index entry');
    }
    const extracted = new TextDecoder().decode(view.slice(entry.o, entry.o + entry.l));
    expect(extracted).toBe(content);
  });
});

describe('parseIpfsResponse', () => {
  it('As a sandbox loading a product, I get a response that is not a CAR archive and serve it as the single index.html', async () => {
    // Given
    const html = new TextEncoder().encode('<html><body>Hello</body></html>');

    // When
    const result = await parseIpfsResponse(html);

    // Then
    expect(Object.keys(result)).toEqual(['index.html']);
    expect(new TextDecoder().decode(result['index.html'])).toBe('<html><body>Hello</body></html>');
  });
});

const RAW = 0x55;
const SHA2_256 = 0x12;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

type Blocks = Map<string, Uint8Array>;

function cidOf(bytes: Uint8Array, codec: number): CID {
  return CID.createV1(codec, create(SHA2_256, sha256(bytes)));
}

function putRaw(blocks: Blocks, name: string, bytes: Uint8Array): dagPb.PBLink {
  const cid = cidOf(bytes, RAW);
  blocks.set(cid.toString(), bytes);
  return { Name: name, Hash: cid, Tsize: bytes.length };
}

function putNode(blocks: Blocks, name: string, unixfs: UnixFS, links: dagPb.PBLink[]): dagPb.PBLink {
  const bytes = dagPb.encode(dagPb.prepare({ Data: unixfs.marshal(), Links: links }));
  const cid = cidOf(bytes, dagPb.code);
  blocks.set(cid.toString(), bytes);
  return { Name: name, Hash: cid, Tsize: bytes.length };
}

/** Three directories of eight raw-leaf files each, beside one file split into ten chunks. */
function nestedSite(): { root: CID; blocks: Blocks } {
  const blocks: Blocks = new Map();
  const dirs = ['a', 'b', 'c'].map(dir =>
    putNode(
      blocks,
      dir,
      new UnixFS({ type: 'directory' }),
      Array.from({ length: 8 }, (_, i) => putRaw(blocks, `${String(i)}.js`, enc(`${dir}${String(i)}`))),
    ),
  );
  const chunks = Array.from({ length: 10 }, (_, i) => enc(`chunk-${String(i)};`));
  const big = putNode(
    blocks,
    'big.bin',
    new UnixFS({ type: 'file', blockSizes: chunks.map(chunk => BigInt(chunk.length)) }),
    chunks.map(chunk => putRaw(blocks, '', chunk)),
  );
  const root = putNode(blocks, '', new UnixFS({ type: 'directory' }), [...dirs, big]);
  return { root: root.Hash, blocks };
}

interface HeldSource {
  source: BlockSource;
  /** Lets every held fetch finish. */
  releaseAll: () => void;
  maxInFlight: () => number;
}

/** A block source that holds each fetch until released, counting how many are in flight at once. */
function heldSource(blocks: Blocks): HeldSource {
  const held: (() => void)[] = [];
  let inFlight = 0;
  let max = 0;
  return {
    source: async cid => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await new Promise<void>(resolve => {
        held.push(resolve);
      });
      inFlight -= 1;
      const bytes = blocks.get(cid.toString());
      if (bytes === undefined) {
        throw new Error(`missing block ${cid.toString()}`);
      }
      return bytes;
    },
    releaseAll: () => {
      for (const release of held.splice(0)) {
        release();
      }
    },
    maxInFlight: () => max,
  };
}

// A macrotask turn drains every microtask, so by then the walk has asked for every block it can.
const nextTurn = (): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, 0);
  });

/** Releases the held fetches wave by wave, each once the walk has asked for all it can, until the walk settles. */
async function drive<T>(walk: Promise<T>, held: HeldSource): Promise<T> {
  const settled = walk.then(
    () => true,
    () => true,
  );
  while (!(await Promise.race([settled, nextTurn().then(() => false)]))) {
    held.releaseAll();
  }
  return walk;
}

describe('walkUnixFsDag', () => {
  it('As a dotli user, I load a site of nested directories and at most eight block fetches run at once', async () => {
    // Given: a site whose subdirectories and chunked file each have more blocks than the budget.
    const { root, blocks } = nestedSite();
    const held = heldSource(blocks);

    // When
    const files = await drive(walkUnixFsDag(root, held.source), held);

    // Then
    expect(held.maxInFlight()).toBe(8);
    expect(Object.keys(files)).toHaveLength(25);
    expect(text(files['b/7.js'])).toBe('b7');
    expect(text(files['big.bin'])).toBe(Array.from({ length: 10 }, (_, i) => `chunk-${String(i)};`).join(''));
  });
});
