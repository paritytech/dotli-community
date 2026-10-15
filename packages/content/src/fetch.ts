// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { dur, errorName, log } from '@dotli/shared';

import { m, spans as S } from '@dotli/metrics';
import { CID } from 'multiformats/cid';

export type StatusCallback = (status: string) => void;

export type BitswapBlockSource = (cid: string) => Promise<Uint8Array>;

import { isCarFile, parseIpfsResponse, walkUnixFsDag, type ArchiveFiles, type BlockSource } from './archive.js';
import { defaultGateway, fetchFromIpfs, fetchCarFromIpfs, gatewayHost } from './ipfs.js';
import { assertBlockMatchesCid, rootVerifyingBlockSource } from './verify.js';

const CODEC_DAG_PB = 0x70;
const CODEC_RAW = 0x55;

async function fetchViaBitswapRpc(
  cidString: string,
  blockSource: BitswapBlockSource,
  onStatus?: StatusCallback,
): Promise<FetchResult> {
  const rootCid = CID.parse(cidString);
  log.event(`Fetching ${cidString} via bitswap`, {
    flow: 'content',
    codec: `0x${rootCid.code.toString(16)}`,
    hash: `0x${rootCid.multihash.code.toString(16)}`,
    version: rootCid.version,
  });

  let blockCount = 0;
  const tracedSource: BlockSource = async (cid: CID) => {
    blockCount += 1;
    const stopRpc = m.timer(S.CONTENT_BITSWAP_RPC);
    try {
      const bytes = await blockSource(cid.toString());
      m.count(S.CONTENT_BITSWAP_RPC, { outcome: 'ok' });
      return bytes;
    } catch (err) {
      m.count(S.CONTENT_BITSWAP_RPC, {
        outcome: isAbort(err) ? 'aborted' : 'error',
        reason: errorName(err) ?? 'unknown',
      });
      throw err;
    } finally {
      stopRpc();
    }
  };

  const result = await readViaBitswap(rootCid, tracedSource, onStatus);
  m.distribution(S.CONTENT_BITSWAP_BLOCKS, blockCount, 'none');
  return result;
}

async function readViaBitswap(rootCid: CID, blockSource: BlockSource, onStatus?: StatusCallback): Promise<FetchResult> {
  // The host's relay checked every block. Re-hashing the root ties the walk to the CID this sandbox was given.
  const rootVerifyingSource = rootVerifyingBlockSource(rootCid, blockSource);

  if (rootCid.code === CODEC_RAW) {
    onStatus?.('Fetching block via bitswap...');
    return readRawRoot(await rootVerifyingSource(rootCid));
  }

  if (rootCid.code === CODEC_DAG_PB) {
    onStatus?.('Walking dag-pb via bitswap...');
    return toFetchResult(await walkUnixFsDag(rootCid, rootVerifyingSource));
  }

  throw new Error(`bitswap-rpc: unsupported root CID codec 0x${rootCid.code.toString(16)} (${rootCid.toString()})`);
}

/**
 * A raw root may hold a whole site packed as one CAR. Its bytes already match the root, and the CAR's own blocks are
 * hashed as it is read.
 */
async function readRawRoot(bytes: Uint8Array): Promise<FetchResult> {
  return isCarFile(bytes) ? toFetchResult(await parseIpfsResponse(bytes)) : { type: 'single', content: bytes };
}

/** A frame's teardown rejects its fetches by the platform's abort name, which is not a failure. */
function isAbort(err: unknown): boolean {
  return errorName(err) === 'AbortError';
}

async function fetchViaGateway(
  cidString: string,
  fetchImpl: typeof fetch,
  onStatus?: StatusCallback,
): Promise<FetchResult> {
  const stopGw = m.timer(S.CONTENT_GATEWAY);
  try {
    return await readViaGateway(cidString, fetchImpl, onStatus);
  } finally {
    stopGw();
  }
}

async function readViaGateway(
  cidString: string,
  fetchImpl: typeof fetch,
  onStatus?: StatusCallback,
): Promise<FetchResult> {
  const cid = CID.parse(cidString);
  const gateway = defaultGateway();
  const host = gatewayHost(gateway);
  if (cid.code === CODEC_DAG_PB) {
    onStatus?.('Fetching archive from IPFS gateway...');
    log.event(`Requesting CAR of ${cidString} from ${host}`, { flow: 'content', gateway: host });
    const gatewayStart = performance.now();
    const carBuffer = await fetchCarFromIpfs(cidString, gateway, fetchImpl);
    log.event(`Fetched ${String(Math.round(carBuffer.length / 1024))} KB CAR from ${host} in ${dur(gatewayStart)}`, {
      flow: 'content',
      gateway: host,
      bytes: carBuffer.length,
    });
    onStatus?.('Parsing content...');
    // Untrusted transport, so the CAR is bound to the requested CID.
    const files = await parseIpfsResponse(carBuffer, cid);
    return toFetchResult(files);
  }
  if (cid.code === CODEC_RAW) {
    onStatus?.('Fetching content via IPFS gateway...');
    log.event(`Requesting raw block ${cidString} from ${host}`, { flow: 'content', gateway: host });
    const gatewayStart = performance.now();
    const { data } = await fetchFromIpfs(cidString, gateway, fetchImpl);
    log.event(`Fetched ${String(Math.round(data.length / 1024))} KB from ${host} in ${dur(gatewayStart)}`, {
      flow: 'content',
      gateway: host,
      bytes: data.length,
    });
    // Untrusted transport.
    assertBlockMatchesCid(cid, data);
    log.event(`Block ${cidString} verified`, { flow: 'content', bytes: data.length });
    return readRawRoot(data);
  }
  throw new Error(`Unsupported CID codec for gateway fetch: 0x${cid.code.toString(16)} (cid=${cidString})`);
}

export type FetchResult = { type: 'single'; content: Uint8Array } | { type: 'archive'; files: ArchiveFiles };

/** Fetch over bitswap when a block source is given, else the gateway. No fallback between the two. */
export async function fetchArchive(
  cidString: string,
  onStatus?: StatusCallback,
  options?: {
    useGateway?: boolean;
    /** The gateway path's network. The page's own `fetch` when not given. */
    gatewayFetch?: typeof fetch;
    bitswapBlockSource?: BitswapBlockSource;
  },
): Promise<FetchResult> {
  performance.mark('dotli:fetch:start');
  const stopFetch = m.timer(S.CONTENT_FETCH);
  const blockSource = options?.bitswapBlockSource;
  const method = blockSource !== undefined ? 'bitswap-rpc' : options?.useGateway === true ? 'gateway' : null;
  if (method === null) {
    stopFetch();
    throw new Error('fetchArchive requires either `bitswapBlockSource` or `useGateway: true`');
  }
  m.tag('content_method', method);

  try {
    const result =
      blockSource !== undefined
        ? await fetchViaBitswapRpc(cidString, blockSource, onStatus)
        : await fetchViaGateway(cidString, options?.gatewayFetch ?? fetch, onStatus);
    performance.mark('dotli:fetch:end');
    measureContentSize(result);
    stopFetch();
    return result;
  } catch (err) {
    performance.mark('dotli:fetch:end');
    stopFetch();
    if (isAbort(err)) {
      // The sandbox ends this load as torn down, so it is a breadcrumb rather than an error.
      log.event(`Fetch of ${cidString} stopped as its frame went away`, { flow: 'content', method });
    } else {
      log.child({ flow: 'content' }).error(`[dot.li fetch] ${method} failed for ${cidString}:`, err);
    }
    throw err;
  }
}

/** Like `fetchArchive` but without marks and metrics, for reads that are not a product load. */
export async function readArchiveFiles(
  cidString: string,
  transport: { blockSource: BitswapBlockSource } | { gateway: true; fetch?: typeof fetch },
): Promise<ArchiveFiles> {
  const result =
    'blockSource' in transport
      ? await readViaBitswap(CID.parse(cidString), cid => transport.blockSource(cid.toString()))
      : await readViaGateway(cidString, transport.fetch ?? fetch);
  return result.type === 'single' ? { 'index.html': result.content } : result.files;
}

function measureContentSize(result: FetchResult): void {
  if (result.type === 'single') {
    m.distribution(S.CONTENT_SIZE, result.content.length, 'byte');
  } else {
    const totalSize = Object.values(result.files).reduce((sum, buf) => sum + buf.length, 0);
    m.distribution(S.CONTENT_SIZE, totalSize, 'byte');
  }
}

function toFetchResult(files: ArchiveFiles): FetchResult {
  const keys = Object.keys(files);
  const index = files['index.html'];
  if (keys.length === 1 && index !== undefined) {
    return { type: 'single', content: index };
  }
  log.event(`Archive has ${String(keys.length)} files`, { flow: 'content', files: keys.length });
  return { type: 'archive', files };
}
