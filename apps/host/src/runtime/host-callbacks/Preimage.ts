// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Polls the selected content backend until the preimage is found or the subscription drops.

import type { PreimageHost } from '@parity/truapi-host';
import { bitswapGet } from '@dotli/bitswap';
import { hashToCid, fetchFromIpfs, assertBlockMatchesCid } from '@dotli/content';
import { getBackend, type Backend } from '@dotli/config';
import { createAsyncTaskPool, serializeError, log, toHex } from '@dotli/shared';
import { createResultStream } from './result-stream.js';

const POLL_INTERVAL_MS = 10_000;
const INITIAL_POLL_DELAY_MS = 1000;
const preimageCache = new Map<string, Uint8Array>();

/** A block as one content backend returned it. Empty data is a miss. */
export interface PreimageBlock {
  data: Uint8Array;
  source: Backend;
}

export type PreimageFetch = (cid: string, signal: AbortSignal) => Promise<PreimageBlock>;

export interface PreimageDeps {
  fetchBlock: PreimageFetch;
}

export interface BlockSources {
  backend: () => Backend;
  bitswap: (cid: string, signal: AbortSignal) => Promise<Uint8Array>;
  gateway: (cid: string) => Promise<Uint8Array>;
}

/** Fetches over the backend selected at call time, so a settings change applies to the next attempt. */
export function createBlockFetch(sources: BlockSources): PreimageFetch {
  return async (cid, signal) => {
    const source = sources.backend();
    try {
      const data = source === 'rpc-gateway' ? await sources.gateway(cid) : await sources.bitswap(cid, signal);
      return { data, source };
    } catch (err) {
      throw new Error(`Preimage fetch via ${source} failed`, { cause: err });
    }
  };
}

const fetchContentBlock = createBlockFetch({
  backend: getBackend,
  bitswap: bitswapGet,
  gateway: async cid => (await fetchFromIpfs(cid)).data,
});

/** The backend answered with the wrong bytes, which another attempt would not change. */
class PreimageMismatch extends Error {}

/** Not found yet, so the poll goes on. */
class PreimageMiss extends Error {}

function noop(): void {
  return;
}

function createPreimageLookupSubscribe(label: string, deps: PreimageDeps): Required<PreimageHost>['lookupPreimage'] {
  // One attempt per key at a time, since a bitswap lookup can outlive the poll interval and a second subscription to
  // the key would open another retry budget for the same block.
  const polls = createAsyncTaskPool({
    poolSize: 1,
    retryCount: Number.POSITIVE_INFINITY,
    retryDelay: POLL_INTERVAL_MS,
    retryIf: error => !(error instanceof PreimageMismatch),
  });

  return request => {
    const key = toHex(request);
    log.debug(`[${label}] Preimage lookup subscribe, key: ${key}`);

    const cached = preimageCache.get(key);
    if (cached) {
      // Stays open after the hit, like the polling path, because the core cancels lookupPreimage from
      // the product side and never waits for `done`.
      return createResultStream<Uint8Array | undefined>([cached], () => noop);
    }

    return createResultStream<Uint8Array | undefined>([undefined], (push, pushError) => {
      const cid = hashToCid(key);
      // Aborting also reaches a running fetch, and a retrying bitswapGet can keep fetching for minutes after the
      // consumer has gone.
      const aborter = new AbortController();
      const attempt = async (): Promise<Uint8Array> => {
        const hit = preimageCache.get(key);
        if (hit) {
          return hit;
        }
        let block: PreimageBlock;
        try {
          block = await deps.fetchBlock(cid.toString(), aborter.signal);
        } catch (err) {
          // Teardown aborts the in-flight lookup, so this ends a dropped subscription, not a failure.
          if (!aborter.signal.aborted) {
            log.warn(`[${label}] preimage lookup failed:`, err);
          }
          throw err;
        }
        if (block.data.length === 0) {
          throw new PreimageMiss(`Preimage not found via ${block.source}`);
        }
        try {
          assertBlockMatchesCid(cid, block.data);
        } catch (err) {
          throw new PreimageMismatch(`preimage lookup via ${block.source} failed: ${serializeError(err)}`, {
            cause: err,
          });
        }
        preimageCache.set(key, block.data);
        return block.data;
      };

      polls.call(attempt, { pool: key, signal: aborter.signal, delay: INITIAL_POLL_DELAY_MS }).then(
        data => {
          push(data);
        },
        (err: unknown) => {
          if (err instanceof PreimageMismatch) {
            pushError({ reason: err.message });
          }
          // The poll retries every other failure, so any other end is the abort of a subscription that has gone.
        },
      );

      return () => {
        aborter.abort();
      };
    });
  };
}

export function createPreimageAdapters(
  label: string,
  deps: PreimageDeps = { fetchBlock: fetchContentBlock },
): Required<PreimageHost> {
  return {
    lookupPreimage: createPreimageLookupSubscribe(label, deps),
  };
}
