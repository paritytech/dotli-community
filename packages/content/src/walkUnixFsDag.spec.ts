// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import * as dagPb from '@ipld/dag-pb';
import { UnixFS } from 'ipfs-unixfs';
import type { CID } from 'multiformats/cid';
import { must } from '@dotli/shared/testing';
import { RAW } from './codecs.js';
import { createPackedSite } from './testing/createPackedSite.js';
import { createSha256Cid } from './testing/createSha256Cid.js';
import { decodeText, encodeText } from './testing/textCodec.js';
import type { ArchiveFiles, BlockSource } from './types.js';
import { walkUnixFsDag } from './walkUnixFsDag.js';

type Blocks = Map<string, Uint8Array>;

type HeldSource = ReturnType<typeof createHeldSource>;

function putRaw(blocks: Blocks, name: string, bytes: Uint8Array): dagPb.PBLink {
  const cid = createSha256Cid(bytes, RAW);
  blocks.set(cid.toString(), bytes);
  return { Name: name, Hash: cid, Tsize: bytes.length };
}

function putNode(blocks: Blocks, name: string, unixfs: UnixFS, links: dagPb.PBLink[]): dagPb.PBLink {
  const bytes = dagPb.encode(dagPb.prepare({ Data: unixfs.marshal(), Links: links }));
  const cid = createSha256Cid(bytes, dagPb.code);
  blocks.set(cid.toString(), bytes);
  return { Name: name, Hash: cid, Tsize: bytes.length };
}

/** A file split into `count` raw chunks. */
function putChunkedFile(blocks: Blocks, name: string, count: number): dagPb.PBLink {
  const chunks = Array.from({ length: count }, (_, i) => encodeText(`${name}-${String(i)};`));
  return putNode(
    blocks,
    name,
    new UnixFS({ type: 'file', blockSizes: chunks.map(chunk => BigInt(chunk.length)) }),
    chunks.map(chunk => putRaw(blocks, '', chunk)),
  );
}

/** A file whose chunks sit two levels down: the root links one inner file node per group, each linking raw chunks. */
function putTwoLevelFile(blocks: Blocks, name: string, groups: string[][], blockSizes?: bigint[]): dagPb.PBLink {
  const inner = groups.map(group => {
    const chunks = group.map(chunk => encodeText(chunk));
    return putNode(
      blocks,
      '',
      new UnixFS({ type: 'file', blockSizes: chunks.map(chunk => BigInt(chunk.length)) }),
      chunks.map(chunk => putRaw(blocks, '', chunk)),
    );
  });
  const sizes = blockSizes ?? groups.map(group => BigInt(encodeText(group.join('')).length));
  return putNode(blocks, name, new UnixFS({ type: 'file', blockSizes: sizes }), inner);
}

/** A HAMT shard with a fanout of 256, so each link name starts with a two-digit hex bucket. */
function putShard(blocks: Blocks, name: string, links: dagPb.PBLink[]): dagPb.PBLink {
  return putNode(blocks, name, new UnixFS({ type: 'hamt-sharded-directory', fanout: 256n }), links);
}

/** A block source over `blocks` that answers at once. */
function createBlockSource(blocks: Blocks): BlockSource {
  return cid => {
    const bytes = blocks.get(cid.toString());
    return bytes === undefined ? Promise.reject(new Error('missing block')) : Promise.resolve(bytes);
  };
}

/** A directory chain `depth` deep, each level holding eight files and the next level, so nine entries. */
function createDeepSite(depth: number): { root: CID; blocks: Blocks; paths: string[] } {
  const blocks: Blocks = new Map();
  const paths: string[] = [];

  function putLevel(path: string, left: number): dagPb.PBLink {
    const links = Array.from({ length: 8 }, (_, i) => {
      paths.push(`${path}${String(i)}.js`);
      return putRaw(blocks, `${String(i)}.js`, encodeText(`${path}${String(i)}`));
    });
    if (left > 1) {
      links.push(putLevel(`${path}d/`, left - 1));
    }
    return putNode(blocks, 'd', new UnixFS({ type: 'directory' }), links);
  }

  return { root: putLevel('', depth).Hash, blocks, paths };
}

/** A block source that holds each fetch until released, counting how many are in flight at once. */
function createHeldSource(blocks: Blocks) {
  const held: (() => void)[] = [];
  const waiting: { count: number; wake: () => void }[] = [];
  let inFlight = 0;
  let max = 0;
  let released = 0;
  return {
    source: async (cid: CID): Promise<Uint8Array> => {
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
    /** Resolves once at least `count` fetches are held. */
    untilHeld: (count: number): Promise<void> =>
      new Promise<void>(resolve => {
        if (held.length >= count) {
          resolve();
        } else {
          waiting.push({ count, wake: resolve });
        }
      }),
    /** How many of the DAG's blocks are not yet released. */
    unreleased: (): number => blocks.size - released,
    /** Lets every held fetch finish. */
    releaseAll: (): void => {
      released += held.length;
      for (const release of held.splice(0)) {
        release();
      }
    },
    /** The most fetches that were in flight at once. */
    maxInFlight: (): number => max,
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

function rejectInnerArchive(): Promise<ArchiveFiles> {
  return Promise.reject(new Error('no inner archive expected'));
}

describe('walkUnixFsDag', () => {
  it('As a visitor, I load a site of several chunked files and at most 8 blocks download at once across the whole walk', async () => {
    // Given
    const blocks: Blocks = new Map();
    const files = ['a.bin', 'b.bin', 'c.bin'].map(name => putChunkedFile(blocks, name, 8));
    const root = putNode(blocks, '', new UnixFS({ type: 'directory' }), files);
    const held = createHeldSource(blocks);

    // When the root, then the file nodes, then the chunks are released wave by wave
    const walked = await drive(
      walkUnixFsDag({ rootCid: root.Hash, blockSource: held.source, parseInnerArchive: rejectInnerArchive }),
      held,
      [1, 3],
      8,
    );

    // Then
    expect(held.maxInFlight()).toBe(8);
    expect(Object.keys(walked)).toHaveLength(3);
  });

  it('As a visitor, I load a site nested deeper than the download budget and the walk finishes', async () => {
    // Given a folder chain twice as deep as the 8 downloads the walk runs at once
    const { root, blocks, paths } = createDeepSite(16);

    // When the walk runs
    const files = await walkUnixFsDag({
      rootCid: root,
      blockSource: createBlockSource(blocks),
      parseInnerArchive: rejectInnerArchive,
    });

    // Then every file arrives
    expect(Object.keys(files).sort()).toEqual(paths.sort());
  });

  it('As a visitor, I load a file whose chunk tree is two levels deep and get every byte of it', async () => {
    // Given a file whose root links to two chunk nodes, each linking to leaves
    const blocks: Blocks = new Map();
    const file = putTwoLevelFile(blocks, 'big.bin', [
      ['a1;', 'a2;'],
      ['b1;', 'b2;', 'b3;'],
    ]);

    // When the walk reads it
    const files = await walkUnixFsDag({
      rootCid: file.Hash,
      blockSource: createBlockSource(blocks),
      parseInnerArchive: rejectInnerArchive,
    });

    // Then the leaves arrive whole and in order
    expect(decodeText(must(files['index.html'], 'index.html'))).toBe('a1;a2;b1;b2;b3;');
  });

  it('As a visitor, I load a file that comes to another size than it declares and the load fails instead of truncating', async () => {
    // Given a file whose root declares more bytes than its chunks hold
    const blocks: Blocks = new Map();
    const file = putTwoLevelFile(blocks, 'big.bin', [['a1;'], ['b1;']], [3n, 100n]);

    // When the walk reads it
    const walk = walkUnixFsDag({
      rootCid: file.Hash,
      blockSource: createBlockSource(blocks),
      parseInnerArchive: rejectInnerArchive,
    });

    // Then the walk fails naming the declared size
    await expect(walk).rejects.toThrow(/declares 103/);
  });

  it('As a visitor, I load a site whose directory is HAMT-sharded and get each file under its own name', async () => {
    // Given a root shard with one entry and one deeper shard holding another
    const blocks: Blocks = new Map();
    const deeper = putShard(blocks, '1F', [putRaw(blocks, 'C0app.js', encodeText('run()'))]);
    const root = putShard(blocks, '', [putRaw(blocks, 'A3index.html', encodeText('<h1>hi</h1>')), deeper]);

    // When the walk reads it
    const files = await walkUnixFsDag({
      rootCid: root.Hash,
      blockSource: createBlockSource(blocks),
      parseInnerArchive: rejectInnerArchive,
    });

    // Then each file arrives under its name, without the shard prefix
    expect(Object.keys(files).sort()).toEqual(['app.js', 'index.html']);
    expect(decodeText(must(files['app.js'], 'app.js'))).toBe('run()');
  });

  it('As a visitor, I load a site with a HAMT-sharded folder inside a plain one and its files keep the folder path', async () => {
    // Given a plain root holding a sharded `docs` folder
    const blocks: Blocks = new Map();
    const docs = putShard(blocks, 'docs', [putRaw(blocks, '7Bintro.html', encodeText('intro'))]);
    const root = putNode(blocks, '', new UnixFS({ type: 'directory' }), [
      putRaw(blocks, 'index.html', encodeText('home')),
      docs,
    ]);

    // When the walk reads it
    const files = await walkUnixFsDag({
      rootCid: root.Hash,
      blockSource: createBlockSource(blocks),
      parseInnerArchive: rejectInnerArchive,
    });

    // Then the sharded files sit under the folder
    expect(Object.keys(files).sort()).toEqual(['docs/intro.html', 'index.html']);
  });

  it('As a visitor whose load failed on a missing block, I see the failed walk fetch no more blocks', async () => {
    // Given a root linking a missing file and a folder of 40 files, over a source that records every call
    const blocks: Blocks = new Map();
    const bigLinks = Array.from({ length: 40 }, (_, i) =>
      putRaw(blocks, `${String(i)}.js`, encodeText(`file-${String(i)}`)),
    );
    const big = putNode(blocks, 'big', new UnixFS({ type: 'directory' }), bigLinks);
    const missing: dagPb.PBLink = { Name: 'missing.js', Hash: createSha256Cid(encodeText('absent'), RAW), Tsize: 6 };
    const root = putNode(blocks, '', new UnixFS({ type: 'directory' }), [missing, big]);
    const held = createHeldSource(blocks);
    const calls: Promise<Uint8Array>[] = [];
    const blockSource: BlockSource = cid => {
      const call = held.source(cid);
      calls.push(call);
      return call;
    };

    // When the walk fails on the missing block and every held fetch is released until no new fetch starts
    const walk = walkUnixFsDag({ rootCid: root.Hash, blockSource, parseInnerArchive: rejectInnerArchive });
    await expect(drive(walk, held, [1, 2], 8)).rejects.toThrow('missing block');
    const startedAtRejection = calls.length;
    let seen: number;
    do {
      seen = calls.length;
      held.releaseAll();
      await Promise.allSettled(calls);
    } while (calls.length !== seen);

    // Then the failed walk started no fetch after it failed
    expect(calls.length).toBe(startedAtRejection);
  });

  it('As a visitor, I load a site packed as one CAR at its root and the walk unpacks it with the parser it was given', async () => {
    // Given a raw root block that holds a whole CAR
    const { root, car } = createPackedSite({ 'index.html': 'hi' });
    const received: Uint8Array[] = [];
    function parseInnerArchive(bytes: Uint8Array): Promise<ArchiveFiles> {
      received.push(bytes);
      return Promise.resolve({ 'a.txt': encodeText('a') });
    }

    // When the walk reads it
    const files = await walkUnixFsDag({
      rootCid: root,
      blockSource: createBlockSource(new Map([[root.toString(), car]])),
      parseInnerArchive,
    });

    // Then the files come from the given parser, which got the CAR's bytes
    expect(Object.keys(files)).toEqual(['a.txt']);
    expect(received).toEqual([car]);
  });
});
