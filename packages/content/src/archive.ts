// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// CAR archive parsing and MIME type detection.
//
// Parses IPFS CAR (Content-Addressable aRchive) files into a file map.

import { CarReader } from "@ipld/car";
import * as dagPb from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import type { CID } from "multiformats/cid";
import { concatBytes } from "@noble/hashes/utils.js";
import {
  assertBlockMatchesCid,
  assertSameContentId,
  verifyingBlockSource,
} from "./verify";

export type ArchiveFiles = Record<string, Uint8Array>;

export function isCarFile(buffer: Uint8Array): boolean {
  if (buffer.length < 10) {
    return false;
  }

  let offset = 0;
  let shift = 0;
  let headerLen = 0;

  while (offset < buffer.length && offset < 9) {
    const byte = buffer[offset] as number | undefined;
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
  // Check for CBOR map with "roots" key
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

// CID codec constants
const DAG_PB = 0x70;
const RAW = 0x55;

/**
 * Async block source for {@link walkUnixFsDag}. Given a CID, returns the
 * raw block bytes. Implementations may be CAR-backed (in-memory),
 * bitswap-backed (RPC), or anything else that supplies blocks by CID.
 *
 * Failure semantics: throw if the block is missing or the source can't
 * deliver. The walker doesn't retry. That's the source's job.
 */
export type BlockSource = (cid: CID) => Promise<Uint8Array>;

function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

/** Cap on simultaneous block fetches per node.
 *
 * Keeps one big file or large directory from saturating smoldot bitswap queue.
 */
const MAX_PARALLEL_BLOCK_FETCHES = 8;

/**
 * Walk a UnixFS DAG starting at `rootCid`, fetching blocks via `blockSource`,
 * and assemble a flat map of path to bytes.
 *
 * Used by both the CAR-archive parser (gateway path, blocks already in memory)
 * and the bitswap-rpc fetcher (smoldot path, one block per RPC call). The
 * walker itself is source-agnostic (see `BlockSource`).
 *
 * Failure rules:
 *   - Missing blocks throw. Dangling references are malformed inputs, not
 *     partial successes.
 *   - dag-pb decode failures throw. We never substitute raw protobuf
 *     bytes as user content.
 *   - Unknown codecs at non-root throw. We don't guess what the bytes mean.
 *   - HAMT-sharded directories (UnixFS's format for directories too big to
 *     fit in one dag-pb block) are walked as plain directories. Only the
 *     root shard is visible, so directories with more than ~256 entries
 *     will appear truncated.
 */
export async function walkUnixFsDag(
  rootCid: CID,
  blockSource: BlockSource,
): Promise<ArchiveFiles> {
  const files: ArchiveFiles = {};

  /** Read the raw data bytes from a chunk CID (used for multi-block files). */
  async function getChunkData(cid: CID): Promise<Uint8Array> {
    const bytes = await blockSource(cid);

    if (cid.code === RAW) {
      return bytes;
    }

    if (cid.code === DAG_PB) {
      const node = dagPb.decode(bytes);
      return node.Data
        ? (UnixFS.unmarshal(node.Data).data ?? new Uint8Array(0))
        : new Uint8Array(0);
    }

    throw new Error(
      `Unsupported chunk codec 0x${cid.code.toString(16)} for ${cid.toString()}`,
    );
  }

  /** Bounded-concurrency `Promise.all`. Worker indices preserve input order. */
  async function runBounded(
    count: number,
    work: (i: number) => Promise<void>,
  ): Promise<void> {
    if (count === 0) {
      return;
    }
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < count) {
        const idx = next++;
        await work(idx);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MAX_PARALLEL_BLOCK_FETCHES, count) }, () =>
        worker(),
      ),
    );
  }

  /** Recursively walk a DAG node, collecting files into `files`. */
  async function processNode(cid: CID, path: string): Promise<void> {
    const bytes = await blockSource(cid);
    const isRoot = path === "";

    // Raw codec: bytes ARE the file content. Exception at the root: if
    // the bytes start with the CAR header, the user packed the whole site
    // as one CAR block, so unpack it. Non-root CAR-shaped blocks stay as
    // content (we don't second-guess deeper in the tree).
    if (cid.code === RAW) {
      if (isRoot && isCarFile(bytes)) {
        const inner = await parseCarFile(bytes);
        for (const [p, data] of Object.entries(inner)) {
          files[p] = data;
        }
        return;
      }
      files[path || "index.html"] = bytes;
      return;
    }

    if (cid.code !== DAG_PB) {
      throw new Error(
        `Unsupported codec 0x${cid.code.toString(16)} at path="${path}" (${cid.toString()})`,
      );
    }

    const node = dagPb.decode(bytes);
    const uf = node.Data ? UnixFS.unmarshal(node.Data) : null;
    const isDirectory =
      uf?.type === "directory" || uf?.type === "hamt-sharded-directory";
    const isFile = !uf || uf.type === "file" || uf.type === "raw";

    if (isDirectory) {
      const entries = node.Links.filter(
        (link): link is typeof link & { Name: string } =>
          link.Name !== undefined && link.Name !== "",
      );
      await runBounded(entries.length, async (i) => {
        const link = entries[i];
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
        await runBounded(node.Links.length, async (i) => {
          chunks[i] = await getChunkData(node.Links[i].Hash);
        });
        content = concatBytes(...chunks);
      }

      // Same root-only CAR-packed exception as the RAW branch. Here the
      // CAR was uploaded as a chunked UnixFS file, so the assembled
      // chunks carry the CAR header.
      if (isRoot && isCarFile(content)) {
        const inner = await parseCarFile(content);
        for (const [p, data] of Object.entries(inner)) {
          files[p] = data;
        }
      } else {
        files[path || "index.html"] = content;
      }
      return;
    }

    // UnixFS classified the node as something else (symlink, metadata).
    // Fail loud rather than guess at how to render it.
    throw new Error(
      `Unsupported UnixFS node type "${uf.type}" at path="${path}"`,
    );
  }

  await processNode(rootCid, "");
  return files;
}

/**
 * Parse a CAR archive into a file map.
 *
 * When `expectedRoot` is supplied (untrusted gateway transport), the CAR's
 * declared root is asserted to match it, and every block is hash-verified
 * against the CID that addressed it, so a malicious gateway cannot inject
 * content. Omit it only when the bytes are already trusted to address
 * themselves correctly (e.g. a CAR re-packed under a smoldot-verified CID).
 */
export async function parseCarFile(
  buffer: Uint8Array,
  expectedRoot?: CID,
): Promise<ArchiveFiles> {
  const reader = await CarReader.fromBytes(buffer);
  const roots = await reader.getRoots();
  const rootCid = roots[0] as
    Awaited<ReturnType<typeof reader.getRoots>>[number] | undefined;

  if (rootCid === undefined) {
    throw new Error("CAR file has no roots");
  }

  if (expectedRoot !== undefined) {
    assertSameContentId(rootCid, expectedRoot);
  }

  return walkUnixFsDag(
    rootCid,
    verifyingBlockSource(async (cid: CID) => {
      const block = await reader.get(cid);
      if (!block) {
        throw new Error(`CAR is missing block for ${cid.toString()}`);
      }
      return block.bytes;
    }),
  );
}

/**
 * Parse an IPFS response. If it's a CAR file, extract the archive,
 * otherwise treat the raw bytes as a single index.html.
 *
 * `expectedRoot`, when supplied, binds the response to the requested CID:
 * the CAR root must match, and every block is hash-verified (or, for a
 * non-CAR single block, the bytes themselves are hash-verified).
 */
export async function parseIpfsResponse(
  buffer: Uint8Array,
  expectedRoot?: CID,
): Promise<ArchiveFiles> {
  if (isCarFile(buffer)) {
    return parseCarFile(buffer, expectedRoot);
  }
  if (expectedRoot !== undefined) {
    assertBlockMatchesCid(expectedRoot, buffer);
  }
  return { "index.html": buffer };
}

export interface PackedArchive {
  packed: ArrayBuffer;
  index: { p: string; o: number; l: number }[];
}

/**
 * Pack all archive files into a single ArrayBuffer with an offset index.
 * Transfers 1 Transferable instead of N, reducing the structured clone overhead
 * from O(n_files) to O(1) when sending to the Service Worker.
 */
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
