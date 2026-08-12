// DEPRECATED — legacy host-API backward-compat transport shim.
//
// The TrUAPI host shuttles product frames over a transferred `MessagePort`.
// Products built on the older Nova host-api stack (the `@novasamatech` packages;
// e.g. apps still on `@parity/product-sdk`) instead shuttle raw `Uint8Array`
// frames to/from `window.parent`. Nova also exposes synthetic chain-head follow
// ids to PAPI, so the legacy provider translates those ids back to their TrUAPI
// subscription wire ids. No `@novasamatech/*` dependency is needed.
//
// TODO(remove-legacy-nova): once the last product on the legacy Nova host-api
// stack migrates to `@parity/truapi`, delete this entire file together with
// every other site tagged `remove-legacy-nova` (grep for that tag): the
// window-postMessage probe in `bridge.ts` and
// `tests/legacy-host-bridge.test.ts`. Nothing in the modern MessagePort path
// or the Rust core depends on anything here.

import { withActiveTld } from "@dotli/config/network";
import {
  decodeWireMessage,
  encodeWireMessage,
  VersionedHostAccountGetRequest,
  VersionedRemoteChainHeadBodyRequest,
  VersionedRemoteChainHeadCallRequest,
  VersionedRemoteChainHeadContinueRequest,
  VersionedRemoteChainHeadFollowRequest,
  VersionedRemoteChainHeadHeaderRequest,
  VersionedRemoteChainHeadStopOperationRequest,
  VersionedRemoteChainHeadStorageRequest,
  VersionedRemoteChainHeadUnpinRequest,
  type Codec,
  type WireProvider,
} from "@parity/truapi";
import {
  ACCOUNT_GET_ACCOUNT,
  CHAIN_CALL_HEAD,
  CHAIN_CONTINUE_HEAD,
  CHAIN_FOLLOW_HEAD_SUBSCRIBE,
  CHAIN_GET_HEAD_BODY,
  CHAIN_GET_HEAD_HEADER,
  CHAIN_GET_HEAD_STORAGE,
  CHAIN_STOP_HEAD_OPERATION,
  CHAIN_UNPIN_HEAD,
  SYSTEM_HANDSHAKE,
} from "@parity/truapi/wire-table";

interface VersionedFollowBoundRequest {
  tag: "V1";
  value: {
    genesisHash: string;
    followSubscriptionId: string;
  };
}

interface DecodedFollowBoundRequest {
  genesisHash: string;
  /** The synthetic follow id Nova stamped on the incoming frame. */
  followSubscriptionId: string;
  withFollowSubscriptionId(followSubscriptionId: string): Uint8Array;
}

type FollowBoundDecoder = (payload: Uint8Array) => DecodedFollowBoundRequest;

function createFollowBoundDecoder<T extends VersionedFollowBoundRequest>(
  codec: Codec<T>,
): FollowBoundDecoder {
  return (payload) => {
    const request = codec.dec(payload);
    return {
      genesisHash: request.value.genesisHash,
      followSubscriptionId: request.value.followSubscriptionId,
      withFollowSubscriptionId(followSubscriptionId) {
        if (request.value.followSubscriptionId === followSubscriptionId) {
          return payload;
        }
        request.value.followSubscriptionId = followSubscriptionId;
        return codec.enc(request);
      },
    };
  };
}

const followBoundDecoders = new Map<number, FollowBoundDecoder>([
  [
    CHAIN_GET_HEAD_HEADER.request,
    createFollowBoundDecoder(VersionedRemoteChainHeadHeaderRequest),
  ],
  [
    CHAIN_GET_HEAD_BODY.request,
    createFollowBoundDecoder(VersionedRemoteChainHeadBodyRequest),
  ],
  [
    CHAIN_GET_HEAD_STORAGE.request,
    createFollowBoundDecoder(VersionedRemoteChainHeadStorageRequest),
  ],
  [
    CHAIN_CALL_HEAD.request,
    createFollowBoundDecoder(VersionedRemoteChainHeadCallRequest),
  ],
  [
    CHAIN_UNPIN_HEAD.request,
    createFollowBoundDecoder(VersionedRemoteChainHeadUnpinRequest),
  ],
  [
    CHAIN_CONTINUE_HEAD.request,
    createFollowBoundDecoder(VersionedRemoteChainHeadContinueRequest),
  ],
  [
    CHAIN_STOP_HEAD_OPERATION.request,
    createFollowBoundDecoder(VersionedRemoteChainHeadStopOperationRequest),
  ],
]);

/**
 * A {@link WireProvider} over `window.postMessage`, matching the legacy Nova
 * host-api iframe transport. Pipe it into the core with `pipeProviders` exactly
 * like the MessagePort path.
 */
export interface WindowMessageProvider extends WireProvider {
  /** Replay a frame already read off the `window` (the probe's detection frame). */
  injectInbound(message: Uint8Array): void;
}

/**
 * Translate Nova's synthetic chain-head follow ids at the legacy transport
 * boundary. Nova numbers each follow on a chain monotonically (`follow_0`,
 * `follow_1`, …) while the Rust core requires the exact subscription start
 * frame's request id, so the shim mirrors that counter per genesis and
 * rewrites every follow-bound frame to the wire id of the follow it is bound
 * to. A product can hold several concurrent follows on one genesis (PAPI
 * opens a fresh follow during resync before stopping the previous one);
 * routing by the frame's own synthetic id keeps those from cross-talking.
 * A synthetic id the shim never saw falls back to the first active follow.
 */
export function createLegacyNovaChainHeadProvider(
  provider: WireProvider,
  productId?: string,
): WireProvider {
  /** Per genesis: Nova's synthetic follow id -> follow-start wire request id. */
  const followWireIdsByGenesis = new Map<string, Map<string, string>>();
  // Nova's synthetic counter never resets within a connection — not even
  // after every follow on a genesis stops — so this mirror only resets where
  // Nova's does: handshake (new document) and dispose.
  const nextSyntheticOrdinal = new Map<string, number>();
  const localProductId =
    productId === "localhost" || productId?.startsWith("localhost:") === true
      ? productId
      : undefined;
  const forgetAllFollows = (): void => {
    followWireIdsByGenesis.clear();
    nextSyntheticOrdinal.clear();
  };
  const forgetFollowId = (requestId: string): void => {
    for (const [genesisHash, followIds] of followWireIdsByGenesis) {
      for (const [syntheticId, wireId] of followIds) {
        if (wireId === requestId) {
          followIds.delete(syntheticId);
        }
      }
      if (followIds.size === 0) {
        followWireIdsByGenesis.delete(genesisHash);
      }
    }
  };

  const rewrite = (message: Uint8Array): Uint8Array => {
    const decoded = decodeWireMessage(message);
    if (decoded.isErr()) {
      return message;
    }

    const { requestId, payload } = decoded.value;
    // A legacy transport handshake is the first frame after an iframe reload.
    // The core-side provider survives that navigation, so discard mappings
    // belonging to the previous document before accepting new follows.
    if (payload.id === SYSTEM_HANDSHAKE.request) {
      forgetAllFollows();
      return message;
    }
    if (
      payload.id === ACCOUNT_GET_ACCOUNT.request &&
      localProductId !== undefined
    ) {
      try {
        const request = VersionedHostAccountGetRequest.dec(payload.value);
        const productAccountId = request.value.productAccountId;
        // The legacy core hardcodes `.dot`; a current one appends the active
        // network's TLD. Accept either, otherwise a localhost product on a
        // `.paseo` deployment stops matching and never gets its account.
        const suffixed = new Set([
          `${localProductId}.dot`,
          withActiveTld(localProductId),
        ]);
        if (suffixed.has(productAccountId.dotNsIdentifier)) {
          productAccountId.dotNsIdentifier = localProductId;
          const encoded = encodeWireMessage({
            requestId,
            payload: {
              id: payload.id,
              value: VersionedHostAccountGetRequest.enc(request),
            },
          });
          return encoded.isOk() ? encoded.value : message;
        }
      } catch {
        // Let the core report malformed legacy frames.
        return message;
      }
    }

    if (payload.id === CHAIN_FOLLOW_HEAD_SUBSCRIBE.start) {
      let genesisHash: string;
      try {
        const request = VersionedRemoteChainHeadFollowRequest.dec(
          payload.value,
        );
        genesisHash = request.value.genesisHash;
      } catch {
        // Let the core report malformed legacy frames.
        return message;
      }
      const followIds =
        followWireIdsByGenesis.get(genesisHash) ?? new Map<string, string>();
      const ordinal = nextSyntheticOrdinal.get(genesisHash) ?? 0;
      followIds.set(`follow_${String(ordinal)}`, requestId);
      nextSyntheticOrdinal.set(genesisHash, ordinal + 1);
      followWireIdsByGenesis.set(genesisHash, followIds);
      return message;
    }

    if (payload.id === CHAIN_FOLLOW_HEAD_SUBSCRIBE.stop) {
      forgetFollowId(requestId);
      return message;
    }

    const decodeFollowBoundRequest = followBoundDecoders.get(payload.id);
    if (!decodeFollowBoundRequest) {
      return message;
    }

    try {
      const request = decodeFollowBoundRequest(payload.value);
      const followIds = followWireIdsByGenesis.get(request.genesisHash);
      const followId =
        followIds?.get(request.followSubscriptionId) ??
        followIds?.values().next().value;
      if (followId === undefined) {
        return message;
      }

      const encoded = encodeWireMessage({
        requestId,
        payload: {
          id: payload.id,
          value: request.withFollowSubscriptionId(followId),
        },
      });
      return encoded.isOk() ? encoded.value : message;
    } catch {
      return message;
    }
  };

  const subscribeClose = provider.subscribeClose?.bind(provider);

  return {
    postMessage(message) {
      const decoded = decodeWireMessage(message);
      if (
        decoded.isOk() &&
        decoded.value.payload.id === CHAIN_FOLLOW_HEAD_SUBSCRIBE.interrupt
      ) {
        forgetFollowId(decoded.value.requestId);
      }
      provider.postMessage(message);
    },
    subscribe(callback) {
      return provider.subscribe((message) => {
        callback(rewrite(message));
      });
    },
    subscribeClose,
    dispose() {
      forgetAllFollows();
      provider.dispose();
    },
  };
}

let warned = false;

export function createWindowMessageProvider(
  targetWindow: Window,
  targetOrigin: string,
): WindowMessageProvider {
  if (!warned) {
    warned = true;
    console.warn(
      "[dotli] legacy host-API transport bridge active — migrate this product to @parity/truapi.",
    );
  }

  const subscribers = new Set<(message: Uint8Array) => void>();
  const deliver = (message: Uint8Array): void => {
    for (const callback of subscribers) {
      callback(message);
    }
  };
  const onMessage = (event: MessageEvent): void => {
    if (
      event.source === targetWindow &&
      event.origin === targetOrigin &&
      event.data instanceof Uint8Array
    ) {
      deliver(event.data);
    }
  };
  window.addEventListener("message", onMessage);

  return {
    postMessage(message) {
      targetWindow.postMessage(message, targetOrigin);
    },
    subscribe(callback) {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },
    injectInbound: deliver,
    dispose() {
      window.removeEventListener("message", onMessage);
      subscribers.clear();
    },
  };
}
