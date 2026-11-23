// dot.li — TEMPORARY trusted-RPC route for Media advertisement lookups
//
// Remove this module, and its one use in `Chain.ts`, once the light client
// returns stored statements in a statement subscription's initial snapshot.
//
// To call someone, the host Media service looks up the callee's signed
// endpoint advertisement in the People chain's Statement Store. smoldot
// (@parity/truapi-provider 0.3.1, smoldot-light 2.1) answers
// `statement_subscribeStatement` with an empty initial snapshot: it relays only
// statements gossiped after the subscription, never stored ones. Lookups then
// find no endpoint and AddParticipant fails `NotConnected`.
//
// Scope is deliberately narrow. The core opens a separate connection for each
// lookup and marks every request on it with the id prefix below (host source:
// `ADVERTISEMENT_LOOKUP_REQUEST_ID_PREFIX` in `runtime/media_signaling.rs`).
// Only statement subscribe/unsubscribe requests carrying that prefix go to the
// People chain's trusted RPC node; the chain, Chat, product statement
// subscriptions and live Media inbox gossip stay on the light client. The node
// sees which advertisement topics are looked up, and when, and can withhold
// advertisements; it cannot forge one, because the core verifies the statement
// proof and the account signature of each advertisement itself.

import type { JsonRpcConnection, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { createChainPool, type ChainPool } from '@dotli/protocol';
import { createCoreRpcChainProvider } from '@dotli/resolver';
import { log } from '@dotli/shared';

/** The id prefix the host core puts on every request of an advertisement lookup. */
export const MEDIA_ADVERTISEMENT_LOOKUP_REQUEST_ID_PREFIX = 'truapi:media-advertisement-lookup:';

const LOOKUP_METHODS: Record<string, true> = {
  statement_subscribeStatement: true,
  statement_unsubscribeStatement: true,
};

// Lazy trusted leases with the canonical replay policy; a socket closes with
// its last lookup.
const trustedLookupPool = createChainPool({
  createTransport: createCoreRpcChainProvider,
  destroyDelay: 0,
});

let announced = false;

/** One core connection's route for its advertisement-lookup requests. */
export interface MediaAdvertisementLookupRoute {
  /** Send `request` to the trusted node if it is a marked lookup request; whether it did. */
  send: (request: JsonRpcRequest<unknown>) => boolean;
  close: () => void;
}

/**
 * Route a light-client core connection's marked Media advertisement lookups to
 * the trusted RPC node of `genesisHash`, delivering its answers through
 * `deliver`. TEMPORARY; see the module comment.
 */
export function createMediaAdvertisementLookupRoute(
  genesisHash: string,
  deliver: (message: unknown) => void,
  pool: ChainPool = trustedLookupPool,
): MediaAdvertisementLookupRoute {
  let lease: JsonRpcConnection | null = null;
  let closed = false;
  return {
    send(request) {
      const id: unknown = request.id;
      if (
        closed ||
        typeof id !== 'string' ||
        !id.startsWith(MEDIA_ADVERTISEMENT_LOOKUP_REQUEST_ID_PREFIX) ||
        LOOKUP_METHODS[request.method] !== true
      ) {
        return false;
      }
      if (lease === null) {
        const provider = pool.getLocalProvider(genesisHash);
        if (provider === null) {
          log.warn(
            `[dot.li] TEMPORARY: no trusted RPC node for ${genesisHash}; this Media advertisement lookup stays on the light client, which returns no stored statements.`,
          );
          return false;
        }
        if (!announced) {
          announced = true;
          log.warn(
            '[dot.li] TEMPORARY: Media advertisement lookups use the trusted People RPC node; the light client returns no stored statements.',
          );
        }
        const slot = { connection: null as JsonRpcConnection | null, halted: false };
        const connection = provider(deliver, () => {
          // The broker has answered what was in flight; the next lookup
          // takes a new lease.
          slot.halted = true;
          if (lease === slot.connection) {
            lease = null;
          }
        });
        if (slot.halted) {
          return false;
        }
        slot.connection = lease = connection;
      }
      lease.send(request);
      return true;
    },
    close() {
      closed = true;
      lease?.disconnect();
      lease = null;
    },
  };
}
