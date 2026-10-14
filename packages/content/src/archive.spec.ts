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

/** A file split into `count` raw chunks. */
function putChunkedFile(blocks: Blocks, name: string, count: number): dagPb.PBLink {
  const chunks = Array.from({ length: count }, (_, i) => enc(`${name}-${String(i)};`));
  return putNode(
    blocks,
    name,
    new UnixFS({ type: 'file', blockSizes: chunks.map(chunk => BigInt(chunk.length)) }),
    chunks.map(chunk => putRaw(blocks, '', chunk)),
  );
}

/** A directory chain `depth` deep, each level holding eight files and the next level, so nine entries. */
function deepSite(depth: number): { root: CID; blocks: Blocks; paths: string[] } {
  const blocks: Blocks = new Map();
  const paths: string[] = [];
  const level = (path: string, left: number): dagPb.PBLink => {
    const links = Array.from({ length: 8 }, (_, i) => {
      paths.push(`${path}${String(i)}.js`);
      return putRaw(blocks, `${String(i)}.js`, enc(`${path}${String(i)}`));
    });
    if (left > 1) {
      links.push(level(`${path}d/`, left - 1));
    }
    return putNode(blocks, 'd', new UnixFS({ type: 'directory' }), links);
  };
  return { root: level('', depth).Hash, blocks, paths };
}

interface HeldSource {
  source: BlockSource;
  /** Resolves once at least `count` fetches are held. */
  untilHeld: (count: number) => Promise<void>;
  /** Lets every held fetch finish. */
  releaseAll: () => void;
  /** How many of the DAG's blocks are not yet released. */
  unreleased: () => number;
  maxInFlight: () => number;
}

/** A block source that holds each fetch until released, counting how many are in flight at once. */
function heldSource(blocks: Blocks): HeldSource {
  const held: (() => void)[] = [];
  const waiting: { count: number; wake: () => void }[] = [];
  let inFlight = 0;
  let max = 0;
  let released = 0;
  return {
    source: async cid => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await new Promise<void>(resolve => {
        held.push(resolve);
        for (const waiter of waiting.filter(({ count }) => held.length >= count)) {
          waiting.splice(waiting.indexOf(waiter), 1);
          waiter.wake();
        }
      });
      inFlight -= 1;
      const bytes = blocks.get(cid.toString());
      if (bytes === undefined) {
        throw new Error(`missing block ${cid.toString()}`);
      }
      return bytes;
    },
    untilHeld: count =>
      new Promise<void>(resolve => {
        if (held.length >= count) {
          resolve();
        } else {
          waiting.push({ count, wake: resolve });
        }
      }),
    unreleased: () => blocks.size - released,
    releaseAll: () => {
      released += held.length;
      for (const release of held.splice(0)) {
        release();
      }
    },
    maxInFlight: () => max,
  };
}

/**
 * Releases the held fetches wave by wave. The first waves are the sizes the walk is known to ask for while it still
 * discovers blocks, the rest are full budgets until the last blocks are left.
 */
async function drive<T>(walk: Promise<T>, held: HeldSource, discovery: readonly number[], budget: number): Promise<T> {
  for (const size of discovery) {
    await Promise.race([held.untilHeld(size), walk]);
    held.releaseAll();
  }
  while (held.unreleased() > 0) {
    await Promise.race([held.untilHeld(Math.min(budget, held.unreleased())), walk]);
    held.releaseAll();
  }
  return walk;
}

describe('walkUnixFsDag', () => {
  it('As a visitor loading a site of several chunked files, its chunks download with up to 8 per file at once', async () => {
    // Given
    const blocks: Blocks = new Map();
    const files = ['a.bin', 'b.bin', 'c.bin'].map(name => putChunkedFile(blocks, name, 8));
    const root = putNode(blocks, '', new UnixFS({ type: 'directory' }), files);
    const held = heldSource(blocks);

    // When the root and the file nodes are released and every chunk fetch is held
    const walk = walkUnixFsDag(root.Hash, held.source);
    for (const size of [1, 3]) {
      await Promise.race([held.untilHeld(size), walk]);
      held.releaseAll();
    }
    await Promise.race([held.untilHeld(24), walk]);

    // Then
    expect(held.maxInFlight()).toBe(24);
    held.releaseAll();
    expect(Object.keys(await walk)).toHaveLength(3);
  });

  it('As a visitor loading one big file, at most 8 of its chunks download at once', async () => {
    // Given
    const blocks: Blocks = new Map();
    const big = putChunkedFile(blocks, 'big.bin', 20);
    const held = heldSource(blocks);

    // When
    const files = await drive(walkUnixFsDag(big.Hash, held.source), held, [1], 8);

    // Then
    expect(held.maxInFlight()).toBe(8);
    expect(text(files['index.html'])).toBe(Array.from({ length: 20 }, (_, i) => `big.bin-${String(i)};`).join(''));
  });

  it('As a visitor loading a deep tree, the walk finishes', async () => {
    // Given
    const { root, blocks, paths } = deepSite(4);

    // When
    const files = await walkUnixFsDag(root, cid => {
      const bytes = blocks.get(cid.toString());
      return bytes === undefined ? Promise.reject(new Error('missing block')) : Promise.resolve(bytes);
    });

    // Then
    expect(Object.keys(files).sort()).toEqual(paths.sort());
  });
});
