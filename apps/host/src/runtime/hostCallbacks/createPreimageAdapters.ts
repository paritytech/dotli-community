// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Polls the selected content backend until the preimage is found or the subscription drops.

import type { PreimageHost } from '@parity/truapi-host';
import { createCidFromHash, loadVerify as loadContentVerify } from '@dotli/content';
import { captureException, m, reportExpected, spans as S } from '@dotli/metrics';
import { createAsyncTaskPool, createLazyLoad, serializeError, log, noop, toHex } from '@dotli/shared';
import { reportLazyMiss } from '../../reportLazyMiss.js';
import { fetchContentBlock, type PreimageBlock, type PreimageFetch } from './createBlockFetch.js';
import { createResultStream } from './createResultStream.js';

type Params = {
  /** Where the preimage's block is fetched from. The selected content backend by default. */
  fetchBlock?: PreimageFetch;
  /** The loader of the hashing chunk. Defaults to the content package's. */
  loadVerify?: typeof loadContentVerify;
};

type CreatePreimageLookupSubscribeParams = Required<Params>;

const POLL_INTERVAL_MS = 10_000;
const INITIAL_POLL_DELAY_MS = 1000;
const preimageCache = new Map<string, Uint8Array>();

/**
 * Serves the core's preimage lookups. Each lookup is a stream that yields a cached preimage at once, or else a miss at
 * once, then the preimage once a backend serves bytes that hash to the key, or one error item when a backend serves the
 * wrong bytes.
 */
export function createPreimageAdapters(
  label: string,
  { fetchBlock = fetchContentBlock, loadVerify = loadContentVerify }: Params = {},
): Required<PreimageHost> {
  return {
    lookupPreimage: createPreimageLookupSubscribe(label, { fetchBlock, loadVerify }),
  };
}

/** The backend answered with the wrong bytes, which another attempt would not change. */
class PreimageMismatch extends Error {}

/** Not found yet, so the poll goes on. */
class PreimageMiss extends Error {}

function createPreimageLookupSubscribe(
  label: string,
  { fetchBlock, loadVerify }: CreatePreimageLookupSubscribeParams,
): Required<PreimageHost>['lookupPreimage'] {
  // One attempt per key at a time, since a bitswap lookup can outlive the poll interval and a second subscription to
  // the key would open another retry budget for the same block.
  // The chunk loads on first use, so the bridge chunk carries no hashing code. A failed load is retried with the poll,
  // and the first miss is reported since the poll itself acts on mismatches only.
  const verify = createLazyLoad({
    load: loadVerify,
    onFirstMiss: error => {
      reportLazyMiss({ flow: 'content', step: 'preimage_verify_load', error });
    },
  });
  const polls = createAsyncTaskPool({
    poolSize: 1,
    retryCount: Number.POSITIVE_INFINITY,
    retryDelay: POLL_INTERVAL_MS,
    retryIf: error => !(error instanceof PreimageMismatch),
  });

  function lookupPreimage(request: Uint8Array): ReturnType<Required<PreimageHost>['lookupPreimage']> {
    const key = toHex(request);
    log.debug(`[${label}] Preimage lookup subscribe, key: ${key}`);

    const cached = preimageCache.get(key);
    if (cached) {
      // A hit keeps the stream open, as on the polling path, so it ends only when its iteration stops.
      return createResultStream<Uint8Array | undefined>([cached], () => noop);
    }

    return createResultStream<Uint8Array | undefined>([undefined], (push, pushError) => {
      const cid = createCidFromHash(key);
      // Aborting also reaches a running fetch, which can otherwise go on retrying for minutes after the subscription
      // ends.
      const aborter = new AbortController();
      // The poll retries every 10 s for as long as the product waits, so a backend that keeps failing is recorded once
      // per lookup.
      let failureRecorded = false;
      async function attempt(): Promise<Uint8Array> {
        const hit = preimageCache.get(key);
        if (hit) {
          return hit;
        }
        let block: PreimageBlock;
        try {
          block = await fetchBlock(cid.toString(), aborter.signal);
        } catch (error) {
          // Teardown aborts the in-flight lookup, so this ends a dropped subscription, not a failure.
          if (!aborter.signal.aborted && !failureRecorded) {
            failureRecorded = true;
            reportExpected(error, {
              flow: 'content',
              step: 'preimage_lookup',
              metric: S.PREIMAGE_LOOKUP,
              reason: 'fetch',
              message: `[${label}] preimage lookup failing, the poll keeps retrying:`,
            });
          }
          throw error;
        }
        if (block.data.length === 0) {
          throw new PreimageMiss(`Preimage not found via ${block.source}`);
        }
        const { assertBlockMatchesCid } = await verify();
        try {
          assertBlockMatchesCid(cid, block.data);
        } catch (error) {
          throw new PreimageMismatch(`preimage lookup via ${block.source} failed: ${serializeError(error)}`, {
            cause: error,
          });
        }
        preimageCache.set(key, block.data);
        return block.data;
      }

      polls.call(attempt, { pool: key, signal: aborter.signal, delay: INITIAL_POLL_DELAY_MS }).then(
        data => {
          m.count(S.PREIMAGE_LOOKUP, { outcome: 'ok' });
          push(data);
        },
        (error: unknown) => {
          if (error instanceof PreimageMismatch) {
            // A backend served bytes that do not hash to the key, which no retry fixes.
            log.error(`[${label}] preimage lookup got the wrong bytes:`, error);
            captureException(error, { flow: 'content', step: 'preimage_lookup' });
            m.count(S.PREIMAGE_LOOKUP, { outcome: 'error', reason: 'mismatch' });
            pushError({ reason: error.message });
          }
          // The poll retries every other failure, so any other end is the abort of a subscription that has gone.
        },
      );

      return () => {
        aborter.abort();
      };
    });
  }

  return lookupPreimage;
}
