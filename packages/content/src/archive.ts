// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { CarReader } from '@ipld/car';
import * as dagPb from '@ipld/dag-pb';
import { UnixFS } from 'ipfs-unixfs';
import type { CID } from 'multiformats/cid';
import { concatBytes } from '@noble/hashes/utils.js';
import { log } from '@dotli/shared';
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

const DAG_PB = 0x70;
const RAW = 0x55;

/** Throws when it cannot deliver the block. The walker never retries, so retries belong to the source. */
export type BlockSource = (cid: CID) => Promise<Uint8Array>;

function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

/** Per node, so one big file or directory cannot saturate the smoldot bitswap queue. */
const MAX_PARALLEL_BLOCK_FETCHES = 8;

/**
 * Walk a UnixFS DAG into a flat map of path to bytes. Missing blocks and unknown codecs throw.
 * HAMT-sharded directories are walked as plain ones, so past about 256 entries they appear truncated.
 */
export async function walkUnixFsDag(rootCid: CID, blockSource: BlockSource): Promise<ArchiveFiles> {
  const files: ArchiveFiles = {};

  /** Read the raw data bytes from a chunk CID (used for multi-block files).
   *
   * A chunk is either a raw leaf (bytes are the content) or a dag-pb node.
   * Large files nest: the importer inserts intermediate dag-pb stem nodes
   * whose links point at further stems or leaves, so a dag-pb chunk with
   * links must recurse rather than read only its (usually empty) inline
   * data — that truncated every file beyond one link level to zero bytes.
   */
  async function getChunkData(cid: CID): Promise<Uint8Array> {
    const bytes = await blockSource(cid);

    if (cid.code === RAW) {
      return bytes;
    }

    if (cid.code === DAG_PB) {
      const node = dagPb.decode(bytes);
      const inline = node.Data ? (UnixFS.unmarshal(node.Data).data ?? new Uint8Array(0)) : new Uint8Array(0);
      if (node.Links.length === 0) {
        return inline;
      }
      const chunks = new Array<Uint8Array>(node.Links.length);
      await runBounded(node.Links, async (link, i) => {
        chunks[i] = await getChunkData(link.Hash);
      });
      return inline.byteLength > 0 ? concatBytes(inline, ...chunks) : concatBytes(...chunks);
    }

    throw new Error(`Unsupported chunk codec 0x${cid.code.toString(16)} for ${cid.toString()}`);
  }

  async function runBounded<T>(items: readonly T[], work: (item: T, i: number) => Promise<void>): Promise<void> {
    if (items.length === 0) {
      return;
    }
    const pending = items.entries();
    const worker = async (): Promise<void> => {
      for (const [idx, item] of pending) {
        await work(item, idx);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_BLOCK_FETCHES, items.length) }, () => worker()));
  }

  async function processNode(cid: CID, path: string): Promise<void> {
    const bytes = await blockSource(cid);
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
    const isDirectory = uf?.type === 'directory' || uf?.type === 'hamt-sharded-directory';
    const isFile = !uf || uf.type === 'file' || uf.type === 'raw';

    if (isDirectory) {
      const entries = node.Links.filter(
        (link): link is typeof link & { Name: string } => link.Name !== undefined && link.Name !== '',
      );
      await runBounded(entries, async link => {
        await processNode(link.Hash, joinPath(path, link.Name));
      });
      return;
    }

    if (isFile) {
      let content: Uint8Array;
      if (node.Links.length === 0) {
        content = uf?.data ?? new Uint8Array(0);
      } else {
        const chunks = new Array<Uint8Array>(node.Links.length);
        await runBounded(node.Links, async (link, i) => {
          chunks[i] = await getChunkData(link.Hash);
        });
        const inline = uf?.data;
        content =
          inline !== undefined && inline.byteLength > 0 ? concatBytes(inline, ...chunks) : concatBytes(...chunks);
      }

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
export async function parseCarFile(buffer: Uint8Array, expectedRoot?: CID): Promise<ArchiveFiles> {
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
