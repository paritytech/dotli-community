// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getErrorName, log } from '@dotli/shared';
import { m, spans as S } from '@dotli/metrics';
import { CID } from 'multiformats/cid';
import { readViaBitswap, readViaGateway, type ReadViaGatewayParams } from './readArchive.js';
import type { BitswapBlockSource, FetchResult, StatusCallback } from './types.js';
import { createRootVerifyingBlockSource } from './verify.js';

type Params = {
  /** Receives progress text while the fetch runs. */
  onStatus?: StatusCallback;
  /** Fetch from the IPFS gateway when no block source is given. */
  useGateway?: boolean | undefined;
  /** The gateway path's network. The page's own `fetch` when not given. */
  gatewayFetch?: typeof fetch;
  /** Fetch over bitswap through this source, in place of the gateway. */
  bitswapBlockSource?: BitswapBlockSource | undefined;
};

type FetchMethod = 'bitswap-rpc' | 'gateway';

type BitswapRpcParams = {
  /** The root CID to fetch, as a string. */
  cid: string;
  /** Where each block comes from. */
  blockSource: BitswapBlockSource;
  /** Receives progress text while the fetch runs. */
  onStatus?: StatusCallback | undefined;
};

/**
 * Fetch over bitswap when a block source is given, else the gateway. No fallback between the two. Rejects when neither
 * is given, or with the failure of the fetch.
 */
export async function fetchArchive(
  cid: string,
  { onStatus, useGateway, gatewayFetch, bitswapBlockSource }: Params = {},
): Promise<FetchResult> {
  performance.mark('dotli:fetch:start');
  const stopFetch = m.timer(S.CONTENT_FETCH);
  const method = getFetchMethod({ bitswapBlockSource, useGateway });
  if (method === null) {
    stopFetch();
    throw new Error('fetchArchive requires either `bitswapBlockSource` or `useGateway: true`');
  }
  m.tag('content_method', method);

  try {
    const result =
      bitswapBlockSource !== undefined
        ? await fetchViaBitswapRpc({ cid, blockSource: bitswapBlockSource, onStatus })
        : await fetchViaGateway({ cid, fetch: gatewayFetch ?? fetch, onStatus });
    performance.mark('dotli:fetch:end');
    measureContentSize(result);
    stopFetch();
    return result;
  } catch (error) {
    performance.mark('dotli:fetch:end');
    stopFetch();
    if (isAbort(error)) {
      // The sandbox ends this load as torn down, so it is a breadcrumb rather than an error.
      log.event(`Fetch of ${cid} stopped as its frame went away`, { flow: 'content', method });
    } else {
      log.createChild({ flow: 'content' }).error(`[dot.li fetch] ${method} failed for ${cid}:`, error);
    }
    throw error;
  }
}

function getFetchMethod({
  bitswapBlockSource,
  useGateway,
}: Pick<Params, 'bitswapBlockSource' | 'useGateway'>): FetchMethod | null {
  if (bitswapBlockSource !== undefined) {
    return 'bitswap-rpc';
  }
  if (useGateway === true) {
    return 'gateway';
  }
  return null;
}

async function fetchViaBitswapRpc({ cid: cidString, blockSource, onStatus }: BitswapRpcParams): Promise<FetchResult> {
  const rootCid = CID.parse(cidString);
  log.event(`Fetching ${cidString} via bitswap`, {
    flow: 'content',
    codec: `0x${rootCid.code.toString(16)}`,
    hash: `0x${rootCid.multihash.code.toString(16)}`,
    version: rootCid.version,
  });

  let blockCount = 0;

  async function traceBlock(cid: CID): Promise<Uint8Array> {
    blockCount += 1;
    const stopRpc = m.timer(S.CONTENT_BITSWAP_RPC);
    try {
      const bytes = await blockSource(cid.toString());
      m.count(S.CONTENT_BITSWAP_RPC, { outcome: 'ok' });
      return bytes;
    } catch (error) {
      m.count(S.CONTENT_BITSWAP_RPC, {
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
  m.distribution(S.CONTENT_BITSWAP_BLOCKS, blockCount, { unit: 'none' });
  return result;
}

async function fetchViaGateway(params: ReadViaGatewayParams): Promise<FetchResult> {
  const stopGateway = m.timer(S.CONTENT_GATEWAY);
  try {
    return await readViaGateway(params);
  } finally {
    stopGateway();
  }
}

function measureContentSize(result: FetchResult): void {
  if (result.type === 'single') {
    m.distribution(S.CONTENT_SIZE, result.content.length, { unit: 'byte' });
  } else {
    const totalSize = Object.values(result.files).reduce((sum, file) => sum + file.length, 0);
    m.distribution(S.CONTENT_SIZE, totalSize, { unit: 'byte' });
  }
}

/** A frame's teardown rejects its fetches by the platform's abort name, which is not a failure. */
function isAbort(error: unknown): boolean {
  return getErrorName(error) === 'AbortError';
}
