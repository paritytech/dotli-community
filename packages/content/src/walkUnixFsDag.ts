// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import * as dagPb from '@ipld/dag-pb';
import { UnixFS } from 'ipfs-unixfs';
import type { CID } from 'multiformats/cid';
import { concatBytes } from '@noble/hashes/utils.js';
import { createAsyncTaskPool } from '@dotli/shared';
import { DAG_PB, RAW } from './codecs.js';
import { isCarFile } from './isCarFile.js';
import type { ArchiveFiles, BlockSource } from './types.js';

type Params = {
  /** The root of the DAG. */
  rootCid: CID;
  /** Where each block comes from. */
  blockSource: BlockSource;
  /** Unpacks a root that holds a whole CAR into its files. */
  parseInnerArchive: (bytes: Uint8Array) => Promise<ArchiveFiles>;
};

type ShardParams = {
  node: dagPb.PBNode;
  fanout: bigint | undefined;
  path: string;
};

/** At most this many block fetches run at once in one walk, so a wide or deep DAG cannot saturate the bitswap queue. */
const MAX_PARALLEL_BLOCK_FETCHES = 8;

/**
 * Walk a UnixFS DAG into a flat map of path to bytes. Plain and HAMT-sharded directories are read, and a file is read
 * through every level of its chunk tree and must come to the size it declares. Missing blocks and unknown codecs throw.
 */
export async function walkUnixFsDag({ rootCid, blockSource, parseInnerArchive }: Params): Promise<ArchiveFiles> {
  const files: ArchiveFiles = {};
  // The pool bounds only the fetches, so a node waiting on its children never holds a slot they need.
  const fetches = createAsyncTaskPool({ poolSize: MAX_PARALLEL_BLOCK_FETCHES });

  const walkAbort = new AbortController();

  function fetchBlock(cid: CID): Promise<Uint8Array> {
    return fetches.call(() => blockSource(cid), { signal: walkAbort.signal });
  }

  /** One chunk of a file and everything under it. */
  async function readFileTree(cid: CID): Promise<Uint8Array> {
    const bytes = await fetchBlock(cid);
    if (cid.code === RAW) {
      return bytes;
    }
    if (cid.code === DAG_PB) {
      return readFileNode(cid, dagPb.decode(bytes));
    }
    throw new Error(`Unsupported chunk codec 0x${cid.code.toString(16)} for ${cid.toString()}`);
  }

  /** A file node's own bytes followed by its children's, which must add up to the size it declares. */
  async function readFileNode(cid: CID, node: dagPb.PBNode): Promise<Uint8Array> {
    const unixFs = node.Data ? UnixFS.unmarshal(node.Data) : null;
    if (unixFs !== null && unixFs.type !== 'file' && unixFs.type !== 'raw') {
      throw new Error(`Unexpected UnixFS node type "${unixFs.type}" inside a file (${cid.toString()})`);
    }
    const own = unixFs?.data ?? new Uint8Array(0);
    if (node.Links.length === 0) {
      return own;
    }
    const content = concatBytes(own, ...(await Promise.all(node.Links.map(link => readFileTree(link.Hash)))));
    if (unixFs !== null && BigInt(content.length) !== unixFs.fileSize()) {
      throw new Error(
        `File ${cid.toString()} came to ${String(content.length)} bytes but declares ${unixFs.fileSize().toString()}`,
      );
    }
    return content;
  }

  /**
   * A HAMT shard's link names start with their bucket in hex. A link that is only a bucket is a deeper shard of the same
   * directory, and any other link is an entry whose name follows its bucket.
   */
  async function processShard({ node, fanout, path }: ShardParams): Promise<void> {
    if (fanout === undefined) {
      throw new Error(`HAMT shard at path="${path}" declares no fanout`);
    }
    const bucketLength = (fanout - 1n).toString(16).length;
    await Promise.all(
      listNamedLinks(node).map(async link => {
        if (link.Name.length === bucketLength) {
          const child = dagPb.decode(await fetchBlock(link.Hash));
          const shard = child.Data ? UnixFS.unmarshal(child.Data) : null;
          if (shard?.type !== 'hamt-sharded-directory') {
            throw new Error(`HAMT bucket "${link.Name}" at path="${path}" is not a shard (${link.Hash.toString()})`);
          }
          await processShard({ node: child, fanout: shard.fanout, path });
          return;
        }
        await processNode(link.Hash, joinPath(path, link.Name.slice(bucketLength)));
      }),
    );
  }

  async function processNode(cid: CID, path: string): Promise<void> {
    const bytes = await fetchBlock(cid);
    const isRoot = path === '';

    // A CAR at the root is a whole site packed as one block. Deeper CAR-shaped blocks stay content.
    if (cid.code === RAW) {
      if (isRoot && isCarFile(bytes)) {
        const inner = await parseInnerArchive(bytes);
        for (const [innerPath, data] of Object.entries(inner)) {
          files[innerPath] = data;
        }
        return;
      }
      files[path || 'index.html'] = bytes;
      return;
    }

    if (cid.code !== DAG_PB) {
      throw new Error(`Unsupported codec 0x${cid.code.toString(16)} at path="${path}" (${cid.toString()})`);
    }

    const node = dagPb.decode(bytes);
    const unixFs = node.Data ? UnixFS.unmarshal(node.Data) : null;

    if (unixFs?.type === 'directory') {
      await Promise.all(listNamedLinks(node).map(link => processNode(link.Hash, joinPath(path, link.Name))));
      return;
    }

    if (unixFs?.type === 'hamt-sharded-directory') {
      await processShard({ node, fanout: unixFs.fanout, path });
      return;
    }

    if (unixFs === null || unixFs.type === 'file' || unixFs.type === 'raw') {
      const content = await readFileNode(cid, node);
      // A CAR at the root, uploaded as a chunked file.
      if (isRoot && isCarFile(content)) {
        const inner = await parseInnerArchive(content);
        for (const [innerPath, data] of Object.entries(inner)) {
          files[innerPath] = data;
        }
      } else {
        files[path || 'index.html'] = content;
      }
      return;
    }

    throw new Error(`Unsupported UnixFS node type "${unixFs.type}" at path="${path}"`);
  }

  try {
    await processNode(rootCid, '');
  } catch (error) {
    // The other branches stop fetching once one has failed the walk.
    walkAbort.abort(error);
    throw error;
  }
  return files;
}

function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

/** A directory node's links that name an entry. */
function listNamedLinks(node: dagPb.PBNode): (dagPb.PBLink & { Name: string })[] {
  return node.Links.filter(
    (link): link is dagPb.PBLink & { Name: string } => link.Name !== undefined && link.Name !== '',
  );
}
