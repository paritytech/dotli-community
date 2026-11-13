// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getErrorName } from '@dotli/shared';
import { createReporter, defineCount, m } from '@dotli/metrics';
import { CID } from 'multiformats/cid';
import { readViaBitswap, readViaGateway, type ReadViaGatewayParams } from './readArchive.js';
import type { BitswapBlockSource, FetchResult, StatusCallback } from './types.js';
import { createRootVerifyingBlockSource } from './verify.js';

const report = createReporter({ flow: 'content' });

/** One content fetch, by the method it is tagged with. */
const CONTENT_FETCH = 'content.fetch';

/**
 * One `bitswap_v1_get` round trip. Tag `outcome` (`ok, error, aborted`) and, on a failure, `reason` (the error name).
 */
const contentBitswapRpcMetric = defineCount<'aborted' | 'error' | 'ok'>('content.bitswap_rpc');

/** Blocks per content fetch, as a distribution: 1 for raw and N for dag-pb directories. */
const CONTENT_BITSWAP_BLOCKS = 'content.bitswap_blocks';

const CONTENT_GATEWAY = 'content.gateway';

/** Bytes. */
const CONTENT_SIZE = 'content.size';

type Params = {
  /** Receives progress text while the fetch runs. */
  onStatus?: StatusCallback;
  /** The gateway path's network. The page's own `fetch` when not given. */
  gatewayFetch?: typeof fetch;
  /** Fetch over bitswap through this source, or from the IPFS gateway when null. */
  bitswapBlockSource: BitswapBlockSource | null;
};

type BitswapRpcParams = {
  /** The root CID to fetch, as a string. */
  cid: string;
  /** Where each block comes from. */
  blockSource: BitswapBlockSource;
  /** Receives progress text while the fetch runs. */
  onStatus?: StatusCallback | undefined;
};

/**
 * Fetch over bitswap when a block source is given, else the gateway. No fallback between the two. Rejects with the
 * failure of the fetch.
 */
export async function fetchArchive(
  cid: string,
  { onStatus, gatewayFetch, bitswapBlockSource }: Params,
): Promise<FetchResult> {
  const method = bitswapBlockSource === null ? 'gateway' : 'bitswap-rpc';
  performance.mark('dotli:fetch:start');
  const stopFetch = m.timer(CONTENT_FETCH);
  m.tag('content_method', method);

  try {
    const result =
      bitswapBlockSource === null
        ? await fetchViaGateway({ cid, fetch: gatewayFetch ?? fetch, onStatus })
        : await fetchViaBitswapRpc({ cid, blockSource: bitswapBlockSource, onStatus });
    measureContentSize(result);
    return result;
  } catch (error) {
    if (isAbort(error)) {
      // The sandbox ends this load as torn down, so it is a breadcrumb rather than an error.
      report.log.event(`Fetch of ${cid} stopped as its frame went away`, { method });
    } else {
      report.log.error(`[dot.li fetch] ${method} failed for ${cid}:`, error);
    }
    throw error;
  } finally {
    performance.mark('dotli:fetch:end');
    stopFetch();
  }
}

async function fetchViaBitswapRpc({ cid: cidString, blockSource, onStatus }: BitswapRpcParams): Promise<FetchResult> {
  const rootCid = CID.parse(cidString);
  report.log.event(`Fetching ${cidString} via bitswap`, {
    codec: `0x${rootCid.code.toString(16)}`,
    hash: `0x${rootCid.multihash.code.toString(16)}`,
    version: rootCid.version,
  });

  let blockCount = 0;

  async function traceBlock(cid: CID): Promise<Uint8Array> {
    blockCount += 1;
    const stopRpc = m.timer(contentBitswapRpcMetric.name);
    try {
      const bytes = await blockSource(cid.toString());
      contentBitswapRpcMetric.count({ outcome: 'ok' });
      return bytes;
    } catch (error) {
      contentBitswapRpcMetric.count({
        outcome: isAbort(error) ? 'aborted' : 'error',
        reason: getErrorName(error) ?? 'unknown',
      });
      throw error;
    } finally {
      stopRpc();
    }
  }

  // The host's relay checked every block. Re-hashing the root ties the walk to the CID this sandbox was given.
  const result = await readViaBitswap({
    rootCid,
    verifiedSource: createRootVerifyingBlockSource(rootCid, traceBlock),
    onStatus,
  });
  m.distribution(CONTENT_BITSWAP_BLOCKS, blockCount, { unit: 'none' });
  return result;
}

async function fetchViaGateway(params: ReadViaGatewayParams): Promise<FetchResult> {
  const stopGateway = m.timer(CONTENT_GATEWAY);
  try {
    return await readViaGateway(params);
  } finally {
    stopGateway();
  }
}

function measureContentSize(result: FetchResult): void {
  const bytes =
    result.type === 'single'
      ? result.content.length
      : Object.values(result.files).reduce((sum, file) => sum + file.length, 0);
  m.distribution(CONTENT_SIZE, bytes, { unit: 'byte' });
}

/** A frame's teardown rejects its fetches by the platform's abort name, which is not a failure. */
function isAbort(error: unknown): boolean {
  return getErrorName(error) === 'AbortError';
}
