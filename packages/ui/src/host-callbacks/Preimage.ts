// Polls the selected content backend until the preimage is found or the subscription drops.

import type { PreimageHost } from '@parity/truapi-host';
import { hashToCid, fetchFromIpfs, assertBlockMatchesCid, bitswapGet } from '@dotli/content';

import { getBackend } from '@dotli/config';
import { serializeError, log, toHex } from '@dotli/shared';

import { createResultStream } from './result-stream.js';

const POLL_INTERVAL_MS = 10_000;
const INITIAL_POLL_DELAY_MS = 1000;
const preimageCache = new Map<string, Uint8Array>();

function noop(): void {
  return;
}

function createPreimageLookupSubscribe(label: string): Required<PreimageHost>['lookupPreimage'] {
  return request => {
    const key = toHex(request);
    log.debug(`[${label}] Preimage lookup subscribe, key: ${key}`);

    const cached = preimageCache.get(key);
    if (cached) {
      // Stays open after the hit, like the polling path, because the core cancels lookupPreimage from
      // the product side and never waits for `done`.
      return createResultStream<Uint8Array | undefined>([cached], () => noop);
    }

    let stopped = false;
    return createResultStream<Uint8Array | undefined>([undefined], (push, pushError) => {
      let intervalId: ReturnType<typeof setInterval> | null = null;
      let initialTimeoutId: ReturnType<typeof setTimeout> | null = null;
      // Clearing the timers does not reach a running lookup, and a retrying bitswapGet can keep
      // fetching for minutes after the consumer has gone.
      const aborter = new AbortController();
      const stopPolling = (): void => {
        stopped = true;
        aborter.abort();
        if (intervalId !== null) {
          clearInterval(intervalId);
          intervalId = null;
        }
        if (initialTimeoutId !== null) {
          clearTimeout(initialTimeoutId);
          initialTimeoutId = null;
        }
      };
      const attempt = async (): Promise<void> => {
        const cached = preimageCache.get(key);
        if (cached) {
          push(cached);
          stopPolling();
          return;
        }

        const cid = hashToCid(key);
        const cidString = cid.toString();
        const backend = getBackend();
        let data: Uint8Array;
        try {
          if (backend !== 'rpc-gateway') {
            data = await bitswapGet(cidString, aborter.signal);
          } else {
            const result = await fetchFromIpfs(cidString);
            data = result.data;
          }
        } catch (err) {
          // Teardown aborts the in-flight lookup, so this ends a dropped subscription, not a failure.
          if (aborter.signal.aborted) {
            return;
          }
          log.warn(`[${label}] preimage lookup via ${backend} failed:`, err);
          return;
        }
        if (aborter.signal.aborted || data.length === 0) {
          return;
        }
        try {
          assertBlockMatchesCid(cid, data);
        } catch (err) {
          stopPolling();
          pushError({
            reason: `preimage lookup via ${backend} failed: ${serializeError(err)}`,
          });
          return;
        }
        preimageCache.set(key, data);
        push(data);
        stopPolling();
      };
      // bitswapGet retries a CID whose providers have not attached yet, so a lookup can outlive the
      // poll interval, and each tick would open another retry budget for the same key.
      let inFlight = false;
      const poll = async (): Promise<void> => {
        if (stopped || inFlight) {
          return;
        }
        inFlight = true;
        try {
          await attempt();
        } finally {
          inFlight = false;
        }
      };

      intervalId = setInterval(() => void poll(), POLL_INTERVAL_MS);
      initialTimeoutId = setTimeout(() => void poll(), INITIAL_POLL_DELAY_MS);

      return () => {
        stopPolling();
      };
    });
  };
}

export function createPreimageAdapters(label: string): Required<PreimageHost> {
  return {
    lookupPreimage: createPreimageLookupSubscribe(label),
  };
}
