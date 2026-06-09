// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li content fetching.
//
// Two paths:
//   - bitswap-rpc: smoldot's `bitswap_v1_get` via the protocol bridge.
//     dag-pb directories are walked block-by-block locally using the
//     UnixFS walker in `archive.ts`.
//   - gateway: HTTPS fetch from a trusted IPFS gateway (CAR for dag-pb,
//     plain GET for raw).
//
// UnixFS walking lives in `archive.ts`, driven by an injected `BlockSource`.

import { dur } from "@dotli/shared/perf";
import { log } from "@dotli/shared/log";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";
import { CID } from "multiformats/cid";

export type StatusCallback = (status: string) => void;

/**
 * Async block source for the bitswap-rpc fetch path. Given a CID string,
 * returns the raw block bytes. Smoldot internally hash-verifies before
 * returning.
 */
export type BitswapBlockSource = (cid: string) => Promise<Uint8Array>;

import {
  isCarFile,
  parseIpfsResponse,
  walkUnixFsDag,
  type ArchiveFiles,
  type BlockSource,
} from "./archive";
import { fetchFromIpfs, fetchCarFromIpfs } from "./ipfs";
import { assertBlockMatchesCid, rootVerifyingBlockSource } from "./verify";

// CID codec constants
const CODEC_DAG_PB = 0x70;
const CODEC_RAW = 0x55;

/**
 * Fetch content via smoldot's `bitswap_v1_get`, walking dag-pb directories
 * block-by-block locally. Smoldot hash-verifies each block before returning.
 */
async function fetchViaBitswapRpc(
  cidString: string,
  blockSource: BitswapBlockSource,
  onStatus?: StatusCallback,
): Promise<FetchResult> {
  const rootCid = CID.parse(cidString);
  log.warn(
    `[dot.li fetch] bitswap-rpc: codec=0x${rootCid.code.toString(16)}, hash=0x${rootCid.multihash.code.toString(16)}, version=${String(rootCid.version)}`,
  );

  let blockCount = 0;
  const tracedSource: BlockSource = async (cid: CID) => {
    blockCount += 1;
    const stopRpc = m.timer(S.CONTENT_BITSWAP_RPC);
    try {
      const bytes = await blockSource(cid.toString());
      m.count(S.CONTENT_BITSWAP_RPC, { outcome: "ok" });
      return bytes;
    } catch (err) {
      m.count(S.CONTENT_BITSWAP_RPC, {
        outcome: classifyBitswapError(err),
      });
      throw err;
    } finally {
      stopRpc();
    }
  };

  // Defense-in-depth: don't trust smoldot's bitswap_v1_get verification
  // blindly — re-check that the root block hashes to the on-chain root CID.
  // Interior blocks are left to smoldot to avoid re-hashing the whole DAG on
  // this default path (the root check alone anchors the rest of the DAG,
  // since every link is followed by CID).
  const rootVerifyingSource = rootVerifyingBlockSource(rootCid, tracedSource);

  if (rootCid.code === CODEC_RAW) {
    onStatus?.("Fetching block via bitswap...");
    const bytes = await rootVerifyingSource(rootCid);
    if (isCarFile(bytes)) {
      // Some uploaders pack a CAR archive under a raw-codec CID. Honor that
      // and unpack into a multi-file archive instead of presenting the raw
      // CAR bytes as `index.html`.
      const files = await parseIpfsResponse(bytes);
      m.count(S.CONTENT_BITSWAP_BLOCKS, { count: String(blockCount) });
      return toFetchResult(files);
    }
    m.count(S.CONTENT_BITSWAP_BLOCKS, { count: String(blockCount) });
    return { type: "single", content: bytes };
  }

  if (rootCid.code === CODEC_DAG_PB) {
    onStatus?.("Walking dag-pb via bitswap...");
    const files = await walkUnixFsDag(rootCid, rootVerifyingSource);
    m.count(S.CONTENT_BITSWAP_BLOCKS, { count: String(blockCount) });
    return toFetchResult(files);
  }

  throw new Error(
    `bitswap-rpc: unsupported root CID codec 0x${rootCid.code.toString(16)} (${cidString})`,
  );
}

function classifyBitswapError(
  err: unknown,
): "not-found" | "invalid-cid" | "timeout" | "aborted" | "error" {
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.includes("not found")) {
      return "not-found";
    }
    if (msg.includes("invalid CID")) {
      return "invalid-cid";
    }
    if (msg.includes("timed out")) {
      return "timeout";
    }
    if (msg.includes("aborted")) {
      return "aborted";
    }
  }
  return "error";
}

/**
 * Fetch content via IPFS gateway.
 *
 * No silent CAR-to-plain fallback. The CID codec deterministically decides
 * which transport is correct:
 *   - DAG-PB (0x70): UnixFS directory or chunked file, request CAR.
 *   - RAW    (0x55): single raw block, plain HTTP GET.
 * Any other codec is a hard failure and we don't guess. Any transport
 * failure surfaces with the original cause.
 */
async function fetchViaGateway(
  cidString: string,
  onStatus?: StatusCallback,
): Promise<FetchResult> {
  const stopGw = m.timer(S.CONTENT_GATEWAY);
  try {
    const cid = CID.parse(cidString);
    if (cid.code === CODEC_DAG_PB) {
      onStatus?.("Fetching archive from IPFS gateway...");
      log.warn(`[dot.li fetch] Gateway: requesting CAR (codec dag-pb)...`);
      const gatewayStart = performance.now();
      const carBuffer = await fetchCarFromIpfs(cidString);
      log.warn(
        `[dot.li fetch] Gateway CAR: fetched ${String(Math.round(carBuffer.length / 1024))} KB in ${dur(gatewayStart)}`,
      );
      onStatus?.("Parsing content...");
      // Untrusted transport: bind the CAR to the on-chain CID — its declared
      // root must match `cid` and every block is hash-verified.
      const files = await parseIpfsResponse(carBuffer, cid);
      return toFetchResult(files);
    }
    if (cid.code === CODEC_RAW) {
      onStatus?.("Fetching content via IPFS gateway...");
      log.warn(`[dot.li fetch] Gateway: plain GET (codec raw)...`);
      const gatewayStart = performance.now();
      const { data } = await fetchFromIpfs(cidString);
      log.warn(
        `[dot.li fetch] Gateway: fetched ${String(Math.round(data.length / 1024))} KB in ${dur(gatewayStart)}`,
      );
      // Untrusted transport: the bytes must hash to the requested raw CID.
      assertBlockMatchesCid(cid, data);
      return { type: "single", content: data };
    }
    throw new Error(
      `Unsupported CID codec for gateway fetch: 0x${cid.code.toString(16)} (cid=${cidString})`,
    );
  } finally {
    stopGw();
  }
}

export type FetchResult =
  | { type: "single"; content: Uint8Array }
  | { type: "archive"; files: ArchiveFiles };

/**
 * Fetch content by CID using the specified mode.
 *
 * - `bitswapBlockSource` (preferred when set): smoldot's `bitswap_v1_get`
 *   via the protocol bridge.
 * - `useGateway: true`: HTTPS fetch from IPFS gateway.
 * - default: throws. The caller must pick one of the two paths.
 *
 * No fallback between modes. If the chosen path fails, it fails.
 */
export async function fetchArchive(
  cidString: string,
  onStatus?: StatusCallback,
  options?: {
    useGateway?: boolean;
    bitswapBlockSource?: BitswapBlockSource;
  },
): Promise<FetchResult> {
  performance.mark("dotli:fetch:start");
  const stopFetch = m.timer(S.CONTENT_FETCH);
  const blockSource = options?.bitswapBlockSource;
  const method =
    blockSource !== undefined
      ? "bitswap-rpc"
      : options?.useGateway === true
        ? "gateway"
        : null;
  if (method === null) {
    stopFetch();
    throw new Error(
      "fetchArchive requires either `bitswapBlockSource` or `useGateway: true`",
    );
  }
  m.tag("content_method", method);

  try {
    const result =
      blockSource !== undefined
        ? await fetchViaBitswapRpc(cidString, blockSource, onStatus)
        : await fetchViaGateway(cidString, onStatus);
    performance.mark("dotli:fetch:end");
    log.warn(`[dot.li fetch] Content fetched via ${method}`);
    measureContentSize(result);
    stopFetch();
    return result;
  } catch (err) {
    performance.mark("dotli:fetch:end");
    stopFetch();
    if (err instanceof Error) {
      log.error(`[dot.li fetch] ${method} failed: ${err.message}`);
    }
    throw err;
  }
}

function measureContentSize(result: FetchResult): void {
  if (result.type === "single") {
    m.distribution(S.CONTENT_SIZE, result.content.length, "byte");
  } else {
    const totalSize = Object.values(result.files).reduce(
      (sum, buf) => sum + buf.length,
      0,
    );
    m.distribution(S.CONTENT_SIZE, totalSize, "byte");
  }
}

function toFetchResult(files: ArchiveFiles): FetchResult {
  const keys = Object.keys(files);
  if (keys.length === 1 && keys[0] === "index.html") {
    return { type: "single", content: files["index.html"] };
  }
  log.warn(
    `[dot.li] Loaded archive with ${String(keys.length)} file(s):`,
    keys,
  );
  return { type: "archive", files };
}
