// Preimage lookup adapter — polls the user-selected content backend
// (Helia P2P or IPFS gateway) until the preimage is found or the
// subscription is dropped.

import type { PreimageHost } from "@parity/truapi-host";
import { hashToCid } from "@dotli/content/preimage";
import { fetchFromIpfs } from "@dotli/content/ipfs";
import { getBackend } from "@dotli/config/mode";
import { serializeError } from "@dotli/shared/errors";
import { log } from "@dotli/shared/log";
import { bitswapGet } from "../bulletin-bitswap";
import { toHex } from "@dotli/shared/hex";
import { createResultStream } from "./result-stream";

const POLL_INTERVAL_MS = 10_000;
const INITIAL_POLL_DELAY_MS = 1000;
const preimageCache = new Map<string, Uint8Array>();

function noop(): void {
  return;
}

function createPreimageLookupSubscribe(
  label: string,
): Required<PreimageHost>["lookupPreimage"] {
  return (request) => {
    const key = toHex(request);
    log.warn(`[${label}] Preimage lookup subscribe, key: ${key}`);

    const cached = preimageCache.get(key);
    if (cached) {
      return createResultStream<Uint8Array | undefined>([cached], () => noop);
    }

    let stopped = false;
    return createResultStream<Uint8Array | undefined>(
      [undefined],
      (push, pushError) => {
        let intervalId: ReturnType<typeof setInterval> | null = null;
        let initialTimeoutId: ReturnType<typeof setTimeout> | null = null;
        const stopPolling = (): void => {
          stopped = true;
          if (intervalId !== null) {
            clearInterval(intervalId);
            intervalId = null;
          }
          if (initialTimeoutId !== null) {
            clearTimeout(initialTimeoutId);
            initialTimeoutId = null;
          }
        };
        const poll = async (): Promise<void> => {
          if (stopped) {
            return;
          }

          const cached = preimageCache.get(key);
          if (cached) {
            push(cached);
            return;
          }

          const cid = hashToCid(key);
          const cidString = cid.toString();
          const backend = getBackend();
          try {
            if (backend !== "rpc-gateway") {
              const data = await bitswapGet(cidString);
              if (data.length > 0) {
                preimageCache.set(key, data);
                push(data);
                stopPolling();
                return;
              }
            } else {
              const result = await fetchFromIpfs(cidString);
              if (result.data.length > 0) {
                preimageCache.set(key, result.data);
                push(result.data);
                stopPolling();
                return;
              }
            }
          } catch (err) {
            log.warn(`[${label}] preimage lookup via ${backend} failed:`, err);
            pushError({
              reason: `preimage lookup via ${backend} failed: ${serializeError(err)}`,
            });
          }
        };

        intervalId = setInterval(() => void poll(), POLL_INTERVAL_MS);
        initialTimeoutId = setTimeout(() => void poll(), INITIAL_POLL_DELAY_MS);

        return () => {
          stopPolling();
        };
      },
    );
  };
}

export function createPreimageAdapters(label: string): Required<PreimageHost> {
  return {
    lookupPreimage: createPreimageLookupSubscribe(label),
  };
}
