// Preimage lookup adapter — polls the user-selected content backend
// (Helia P2P or IPFS gateway) until the preimage is found or the
// subscription is dropped. Mirrors the legacy
// `container.handlePreimageLookupSubscribe` behaviour.

import type { HostCallbacks } from "@parity/truapi-host-wasm";
import { concatBytes } from "@noble/hashes/utils.js";
import { hashToCid } from "@dotli/content/preimage";
import { fetchFromIpfs } from "@dotli/content/ipfs";
import { getContentBackend } from "@dotli/config/mode";
import { log } from "@dotli/shared/log";
import { toHexPrefixed } from "./hex";
import { createResultStream } from "./result-stream";

const POLL_INTERVAL_MS = 10_000;
const INITIAL_POLL_DELAY_MS = 1000;

function createPreimageLookupSubscribe(
  label: string,
): HostCallbacks["lookupPreimage"] {
  return (request) => {
    const key = toHexPrefixed(request);
    log.warn(`[${label}] Preimage lookup subscribe, key: ${key}`);

    let stopped = false;
    return createResultStream<Uint8Array | undefined>([undefined], (push) => {
      const poll = async (): Promise<void> => {
        if (stopped) {
          return;
        }

        const cid = hashToCid(key);
        const cidString = cid.toString();
        const contentBackend = getContentBackend();
        try {
          if (contentBackend === "p2p-helia") {
            const { ensureHelia } = await import("@dotli/content/fetch");
            const helia = await ensureHelia();
            const chunks: Uint8Array[] = [];
            const blockData = helia.blockstore.get(cid);
            if (blockData instanceof Uint8Array) {
              chunks.push(blockData);
            } else if (
              typeof blockData === "object" &&
              Symbol.asyncIterator in Object(blockData)
            ) {
              for await (const chunk of blockData as AsyncIterable<Uint8Array>) {
                chunks.push(chunk);
              }
            }
            if (chunks.length > 0) {
              const data = concatBytes(...chunks);
              if (data.length > 0) {
                push(data);
                return;
              }
            }
          } else {
            const result = await fetchFromIpfs(cidString);
            if (result.data.length > 0) {
              push(result.data);
              return;
            }
          }
        } catch (err) {
          log.warn(
            `[${label}] preimage lookup via ${contentBackend} failed:`,
            err,
          );
        }
      };

      const intervalId = setInterval(() => void poll(), POLL_INTERVAL_MS);
      const initialTimeoutId = setTimeout(
        () => void poll(),
        INITIAL_POLL_DELAY_MS,
      );

      return () => {
        stopped = true;
        clearInterval(intervalId);
        clearTimeout(initialTimeoutId);
      };
    });
  };
}

export function createPreimageAdapters(
  label: string,
): Pick<HostCallbacks, "lookupPreimage"> {
  return {
    lookupPreimage: createPreimageLookupSubscribe(label),
  };
}
