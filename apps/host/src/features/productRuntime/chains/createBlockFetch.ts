// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { fetchFromIpfs } from '@dotli/content';
import { getBackend, hasLightClient, type Backend } from '@dotli/config';
import { hostBitswapClient } from './createHostBitswapClient.js';

/** A block as one content backend returned it. Empty data is a miss. */
export type PreimageBlock = {
  /** The block's bytes as served, not yet checked against the key. */
  data: Uint8Array;
  /** The backend that served it. */
  source: Backend;
};

/** Fetches the block for `cid`, stopping where the backend honours `signal`. Rejects when the backend fails. */
export type PreimageFetch = (cid: string, signal: AbortSignal) => Promise<PreimageBlock>;

/** Where blocks come from on each backend. */
type BlockSources = {
  /** The backend in force, never null. Never throws. */
  backend: () => Backend;
  /** Fetches over bitswap on the light client backends. Rejects when the fetch fails or `signal` aborts. */
  fetchOverBitswap: (cid: string, signal: AbortSignal) => Promise<Uint8Array>;
  /** Fetches over the IPFS gateway on Trusted Providers. Rejects when the fetch fails. */
  fetchFromGateway: (cid: string) => Promise<Uint8Array>;
};

/**
 * Fetches over the backend selected at call time, so a settings change applies to the next attempt. The fetch rejects
 * with an error that names the backend, with the backend's failure as its cause.
 */
export function createBlockFetch({ backend, fetchOverBitswap, fetchFromGateway }: BlockSources): PreimageFetch {
  async function fetchBlock(cid: string, signal: AbortSignal): Promise<PreimageBlock> {
    const source = backend();
    try {
      const data = await (hasLightClient(source) ? fetchOverBitswap(cid, signal) : fetchFromGateway(cid));
      return { data, source };
    } catch (error) {
      throw new Error(`Preimage fetch via ${source} failed`, { cause: error });
    }
  }

  return fetchBlock;
}

/** The page's block fetch over the content backend in force. */
export const fetchContentBlock = createBlockFetch({
  backend: getBackend,
  fetchOverBitswap: (cid, signal) => hostBitswapClient.get(cid, signal),
  fetchFromGateway: async cid => (await fetchFromIpfs(cid)).data,
});
