// DEPRECATED — legacy host-API backward-compat transport shim.
//
// The TrUAPI host shuttles product frames over a transferred `MessagePort`.
// Products built on the older Nova host-api stack (the `@novasamatech` packages;
// e.g. apps still on `@parity/product-sdk`) instead shuttle raw `Uint8Array`
// frames to/from `window.parent`. Nova also exposes synthetic chain-head follow
// ids to PAPI, so the legacy provider translates those ids back to their TrUAPI
// subscription wire ids. No `@novasamatech/*` dependency is needed.
//
// Remove this file (and the probe in `bridge.ts`) once products migrate to
// `@parity/truapi`.

import {
  decodeWireMessage,
  encodeWireMessage,
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
  CHAIN_CALL_HEAD,
  CHAIN_CONTINUE_HEAD,
  CHAIN_FOLLOW_HEAD_SUBSCRIBE,
  CHAIN_GET_HEAD_BODY,
  CHAIN_GET_HEAD_HEADER,
  CHAIN_GET_HEAD_STORAGE,
  CHAIN_STOP_HEAD_OPERATION,
  CHAIN_UNPIN_HEAD,
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
 * boundary. The old Nova host selected the first active follow for a chain;
 * retain that behavior while the Rust core requires the exact subscription
 * start frame's request id.
 */
export function createLegacyNovaChainHeadProvider(
  provider: WireProvider,
): WireProvider {
  const followIdsByGenesis = new Map<string, Set<string>>();

  const rewrite = (message: Uint8Array): Uint8Array => {
    const decoded = decodeWireMessage(message);
    if (decoded.isErr()) {
      return message;
    }

    const { requestId, payload } = decoded.value;
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
      const followIds = followIdsByGenesis.get(genesisHash) ?? new Set();
      followIds.add(requestId);
      followIdsByGenesis.set(genesisHash, followIds);
      return message;
    }

    if (payload.id === CHAIN_FOLLOW_HEAD_SUBSCRIBE.stop) {
      for (const [genesisHash, followIds] of followIdsByGenesis) {
        followIds.delete(requestId);
        if (followIds.size === 0) {
          followIdsByGenesis.delete(genesisHash);
        }
      }
      return message;
    }

    const decodeFollowBoundRequest = followBoundDecoders.get(payload.id);
    if (!decodeFollowBoundRequest) {
      return message;
    }

    try {
      const request = decodeFollowBoundRequest(payload.value);
      const followId = followIdsByGenesis
        .get(request.genesisHash)
        ?.values()
        .next().value;
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
      provider.postMessage(message);
    },
    subscribe(callback) {
      return provider.subscribe((message) => {
        callback(rewrite(message));
      });
    },
    subscribeClose,
    dispose() {
      followIdsByGenesis.clear();
      provider.dispose();
    },
  };
}

let warned = false;

export function createWindowMessageProvider(
  targetWindow: Window,
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
    if (event.source === targetWindow && event.data instanceof Uint8Array) {
      deliver(event.data);
    }
  };
  window.addEventListener("message", onMessage);

  return {
    // "*" matches the credentialless product iframe (its origin reports "null").
    postMessage(message) {
      targetWindow.postMessage(message, "*");
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
