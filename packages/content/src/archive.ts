// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { CarReader } from '@ipld/car';
import * as dagPb from '@ipld/dag-pb';
import { UnixFS } from 'ipfs-unixfs';
import type { CID } from 'multiformats/cid';
import { concatBytes } from '@noble/hashes/utils.js';
import { createAsyncTaskPool, log } from '@dotli/shared';
import { DAG_PB, RAW } from './codecs.js';
import { assertBlockMatchesCid, assertSameContentId, verifyingBlockSource } from './verify.js';

export type ArchiveFiles = Record<string, Uint8Array>;

export function isCarFile(buffer: Uint8Array): boolean {
  if (buffer.length < 10) {
    return false;
  }

  let offset = 0;
  let shift = 0;
  let headerLen = 0;

  while (offset < buffer.length && offset < 9) {
    const byte = buffer[offset];
    if (byte === undefined) {
      return false;
    }
    headerLen |= (byte & 0x7f) << shift;
    offset++;
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7;
  }

  if (buffer.length < offset + headerLen) {
    return false;
  }

  const headerStart = offset;
  // A two-entry CBOR map whose first key is "roots".
  return (
    buffer[headerStart] === 0xa2 &&
    buffer[headerStart + 1] === 0x65 &&
    buffer[headerStart + 2] === 0x72 &&
    buffer[headerStart + 3] === 0x6f &&
    buffer[headerStart + 4] === 0x6f &&
    buffer[headerStart + 5] === 0x74 &&
    buffer[headerStart + 6] === 0x73
  );
}

/** Throws when it cannot deliver the block. The walker never retries, so retries belong to the source. */
export type BlockSource = (cid: CID) => Promise<Uint8Array>;

function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

/** At most this many block fetches run at once in one walk, so a wide or deep DAG cannot saturate the bitswap queue. */
const MAX_PARALLEL_BLOCK_FETCHES = 8;

/** A directory node's links that name an entry. */
function namedLinks(node: dagPb.PBNode): (dagPb.PBLink & { Name: string })[] {
  return node.Links.filter(
    (link): link is dagPb.PBLink & { Name: string } => link.Name !== undefined && link.Name !== '',
  );
}

/**
 * Walk a UnixFS DAG into a flat map of path to bytes. Plain and HAMT-sharded directories are read, and a file is read
 * through every level of its chunk tree and must come to the size it declares. Missing blocks and unknown codecs throw.
 */
export async function walkUnixFsDag(rootCid: CID, blockSource: BlockSource): Promise<ArchiveFiles> {
  const files: ArchiveFiles = {};
  // The pool bounds only the fetches, so a node waiting on its children never holds a slot they need.
  const fetches = createAsyncTaskPool({ poolSize: MAX_PARALLEL_BLOCK_FETCHES });
  const fetchBlock = (cid: CID): Promise<Uint8Array> => fetches.call(() => blockSource(cid));

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
    const uf = node.Data ? UnixFS.unmarshal(node.Data) : null;
    if (uf !== null && uf.type !== 'file' && uf.type !== 'raw') {
      throw new Error(`Unexpected UnixFS node type "${uf.type}" inside a file (${cid.toString()})`);
    }
    const own = uf?.data ?? new Uint8Array(0);
    if (node.Links.length === 0) {
      return own;
    }
    const content = concatBytes(own, ...(await Promise.all(node.Links.map(link => readFileTree(link.Hash)))));
    if (uf !== null && BigInt(content.length) !== uf.fileSize()) {
      throw new Error(
        `File ${cid.toString()} came to ${String(content.length)} bytes but declares ${uf.fileSize().toString()}`,
      );
    }
    return content;
  }

  /**
   * A HAMT shard's link names start with their bucket in hex. A link that is only a bucket is a deeper shard of the same
   * directory, and any other link is an entry whose name follows its bucket.
   */
  async function processShard(node: dagPb.PBNode, fanout: bigint | undefined, path: string): Promise<void> {
    if (fanout === undefined) {
      throw new Error(`HAMT shard at path="${path}" declares no fanout`);
    }
    const bucketLength = (fanout - 1n).toString(16).length;
    await Promise.all(
      namedLinks(node).map(async link => {
        if (link.Name.length === bucketLength) {
          const child = dagPb.decode(await fetchBlock(link.Hash));
          const shard = child.Data ? UnixFS.unmarshal(child.Data) : null;
          if (shard?.type !== 'hamt-sharded-directory') {
            throw new Error(`HAMT bucket "${link.Name}" at path="${path}" is not a shard (${link.Hash.toString()})`);
          }
          await processShard(child, shard.fanout, path);
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
        const inner = await parseCarFile(bytes);
        for (const [p, data] of Object.entries(inner)) {
          files[p] = data;
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
    const uf = node.Data ? UnixFS.unmarshal(node.Data) : null;

    if (uf?.type === 'directory') {
      await Promise.all(namedLinks(node).map(link => processNode(link.Hash, joinPath(path, link.Name))));
      return;
    }

    if (uf?.type === 'hamt-sharded-directory') {
      await processShard(node, uf.fanout, path);
      return;
    }

    if (uf === null || uf.type === 'file' || uf.type === 'raw') {
      const content = await readFileNode(cid, node);
      // A CAR at the root, uploaded as a chunked file.
      if (isRoot && isCarFile(content)) {
        const inner = await parseCarFile(content);
        for (const [p, data] of Object.entries(inner)) {
          files[p] = data;
        }
      } else {
        files[path || 'index.html'] = content;
      }
      return;
    }

    throw new Error(`Unsupported UnixFS node type "${uf.type}" at path="${path}"`);
  }

  await processNode(rootCid, '');
  return files;
}

/**
 * Pass `expectedRoot` for untrusted transports, so the root must match it. Every block is hash-verified.
 * Omit it only for bytes already trusted, such as a CAR re-packed under a smoldot-verified CID.
 */
async function parseCarFile(buffer: Uint8Array, expectedRoot?: CID): Promise<ArchiveFiles> {
  const reader = await CarReader.fromBytes(buffer);
  const roots = await reader.getRoots();
  const rootCid = roots[0];

  if (rootCid === undefined) {
    throw new Error('CAR file has no roots');
  }

  if (expectedRoot !== undefined) {
    assertSameContentId(rootCid, expectedRoot);
  }

  let blocks = 0;
  let bytes = 0;
  const files = await walkUnixFsDag(
    rootCid,
    verifyingBlockSource(async (cid: CID) => {
      const block = await reader.get(cid);
      if (!block) {
        throw new Error(`CAR is missing block for ${cid.toString()}`);
      }
      blocks += 1;
      bytes += block.bytes.length;
      return block.bytes;
    }),
  );
  log.event(`CAR ${rootCid.toString()} verified: ${String(blocks)} blocks`, { flow: 'content', blocks, bytes });
  return files;
}

/** A non-CAR response is a single `index.html`. `expectedRoot` binds the response to the requested CID. */
export async function parseIpfsResponse(buffer: Uint8Array, expectedRoot?: CID): Promise<ArchiveFiles> {
  if (isCarFile(buffer)) {
    return parseCarFile(buffer, expectedRoot);
  }
  if (expectedRoot !== undefined) {
    assertBlockMatchesCid(expectedRoot, buffer);
    log.event(`Block ${expectedRoot.toString()} verified`, { flow: 'content', bytes: buffer.length });
  }
  return { 'index.html': buffer };
}

export interface PackedArchive {
  packed: ArrayBuffer;
  index: { p: string; o: number; l: number }[];
}

/** One buffer plus an offset index, so the Service Worker receives one transferable instead of one per file. */
export function packArchive(files: ArchiveFiles): PackedArchive {
  const entries = Object.entries(files);
  const index: { p: string; o: number; l: number }[] = [];
  let totalSize = 0;
  for (const [, data] of entries) {
    totalSize += data.byteLength;
  }
  const packed = new ArrayBuffer(totalSize);
  const packedView = new Uint8Array(packed);
  let offset = 0;
  for (const [filePath, data] of entries) {
    index.push({ p: filePath, o: offset, l: data.byteLength });
    packedView.set(data, offset);
    offset += data.byteLength;
  }
  return { packed, index };
}
