// TODO(remove-legacy-nova): delete this file together with the tagged
// `legacy-host-bridge.ts` module it covers.

import { describe, expect, it, vi } from "vitest";
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
  MESSAGE_TYPE_INTERRUPT,
  MESSAGE_TYPE_REQUEST,
  MESSAGE_TYPE_START,
  MESSAGE_TYPE_STOP,
  type Codec,
  type MethodIds,
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
import {
  createLegacyNovaChainHeadProvider,
  createWindowMessageProvider,
} from "@dotli/ui/legacy-host-bridge";
import { unwrap } from "./support";

const genesisHash = `0x${"11".repeat(32)}` as const;
const blockHash = `0x${"22".repeat(32)}` as const;

describe("createWindowMessageProvider", () => {
  it("As a dotli integrator, the host pins outbound and inbound frames to the product origin", () => {
    // Given
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const targetWindow = {
      postMessage: vi.fn(),
    } as unknown as Window;
    const targetOrigin = "https://product.app.paseoli.dev";
    const provider = createWindowMessageProvider(targetWindow, targetOrigin);
    const listener = vi.fn();
    provider.subscribe(listener);
    const message = new Uint8Array([1, 2, 3]);

    // When
    provider.postMessage(message);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: message,
        origin: "https://attacker.example",
        source: targetWindow,
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: message,
        origin: targetOrigin,
        source: window,
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: message,
        origin: targetOrigin,
        source: targetWindow,
      }),
    );

    // Then
    expect(targetWindow.postMessage).toHaveBeenCalledWith(
      message,
      targetOrigin,
    );
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(message);

    provider.dispose();
  });
});

type FollowBoundRequest = {
  tag: "V1";
  value: {
    genesisHash: string;
    followSubscriptionId: string;
  };
};

function createHarness(productId?: string): {
  adapted: WireProvider;
  emit(message: Uint8Array): void;
  received: Uint8Array[];
  sent: Uint8Array[];
  dispose: ReturnType<typeof vi.fn>;
} {
  let listener: ((message: Uint8Array) => void) | undefined;
  const dispose = vi.fn();
  const sent: Uint8Array[] = [];
  const provider: WireProvider = {
    postMessage: vi.fn((message: Uint8Array) => sent.push(message)),
    subscribe(callback) {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    dispose,
  };
  const adapted = createLegacyNovaChainHeadProvider(provider, productId);
  const received: Uint8Array[] = [];
  adapted.subscribe((message) => received.push(message));
  return {
    adapted,
    emit(message) {
      listener?.(message);
    },
    received,
    sent,
    dispose,
  };
}

function frame(
  requestId: string,
  ids: MethodIds,
  messageType: number,
  value: Uint8Array,
): Uint8Array {
  return unwrap(
    encodeWireMessage({
      requestId,
      payload: {
        traitId: ids.trait,
        methodId: ids.method,
        messageType,
        value,
      },
    }),
  );
}

function followStart(requestId: string): Uint8Array {
  return frame(
    requestId,
    CHAIN_FOLLOW_HEAD_SUBSCRIBE,
    MESSAGE_TYPE_START,
    VersionedRemoteChainHeadFollowRequest.enc({
      tag: "V1",
      value: { genesisHash, withRuntime: true },
    }),
  );
}

function followStop(requestId: string): Uint8Array {
  return frame(
    requestId,
    CHAIN_FOLLOW_HEAD_SUBSCRIBE,
    MESSAGE_TYPE_STOP,
    new Uint8Array(),
  );
}

function followBoundFrame<T extends FollowBoundRequest>(
  requestId: string,
  ids: MethodIds,
  codec: Codec<T>,
  request: T,
): Uint8Array {
  return frame(requestId, ids, MESSAGE_TYPE_REQUEST, codec.enc(request));
}

function decodedFollowId<T extends FollowBoundRequest>(
  message: Uint8Array,
  codec: Codec<T>,
): string {
  const decoded = unwrap(decodeWireMessage(message));
  return codec.dec(decoded.payload.value).value.followSubscriptionId;
}

describe("createLegacyNovaChainHeadProvider", () => {
  it("As a dotli integrator, the host normalizes the legacy .dot suffix for a localhost product account", () => {
    // Given
    const harness = createHarness("localhost:3000");

    // When
    harness.emit(
      frame(
        "account-request",
        ACCOUNT_GET_ACCOUNT,
        MESSAGE_TYPE_REQUEST,
        VersionedHostAccountGetRequest.enc({
          tag: "V1",
          value: {
            productAccountId: {
              dotNsIdentifier: "localhost:3000.dot",
              derivationIndex: { tag: "Index", value: 0 },
            },
          },
        }),
      ),
    );

    // Then
    const decoded = unwrap(decodeWireMessage(harness.received.at(-1)!));
    expect(
      VersionedHostAccountGetRequest.dec(decoded.payload.value).value
        .productAccountId.dotNsIdentifier,
    ).toBe("localhost:3000");
  });

  it("As a dotli integrator, the host does not rewrite an explicitly requested different product account", () => {
    // Given
    const harness = createHarness("localhost:3000");

    // When
    harness.emit(
      frame(
        "account-request",
        ACCOUNT_GET_ACCOUNT,
        MESSAGE_TYPE_REQUEST,
        VersionedHostAccountGetRequest.enc({
          tag: "V1",
          value: {
            productAccountId: {
              dotNsIdentifier: "other-product.dot",
              derivationIndex: { tag: "Index", value: 0 },
            },
          },
        }),
      ),
    );

    // Then
    const decoded = unwrap(decodeWireMessage(harness.received.at(-1)!));
    expect(
      VersionedHostAccountGetRequest.dec(decoded.payload.value).value
        .productAccountId.dotNsIdentifier,
    ).toBe("other-product.dot");
  });

  it("As a dotli integrator, the host rewrites every follow-bound request to the active wire follow id", () => {
    // Given
    const harness = createHarness();
    harness.emit(followStart("wire-follow"));

    const cases = [
      {
        ids: CHAIN_GET_HEAD_HEADER,
        codec: VersionedRemoteChainHeadHeaderRequest,
        request: {
          tag: "V1",
          value: {
            genesisHash,
            followSubscriptionId: "follow_0",
            hash: blockHash,
          },
        },
      },
      {
        ids: CHAIN_GET_HEAD_BODY,
        codec: VersionedRemoteChainHeadBodyRequest,
        request: {
          tag: "V1",
          value: {
            genesisHash,
            followSubscriptionId: "follow_0",
            hash: blockHash,
          },
        },
      },
      {
        ids: CHAIN_GET_HEAD_STORAGE,
        codec: VersionedRemoteChainHeadStorageRequest,
        request: {
          tag: "V1",
          value: {
            genesisHash,
            followSubscriptionId: "follow_0",
            hash: blockHash,
            items: [],
          },
        },
      },
      {
        ids: CHAIN_CALL_HEAD,
        codec: VersionedRemoteChainHeadCallRequest,
        request: {
          tag: "V1",
          value: {
            genesisHash,
            followSubscriptionId: "follow_0",
            hash: blockHash,
            function: "Metadata_metadata",
            callParameters: "0x" as const,
          },
        },
      },
      {
        ids: CHAIN_UNPIN_HEAD,
        codec: VersionedRemoteChainHeadUnpinRequest,
        request: {
          tag: "V1",
          value: {
            genesisHash,
            followSubscriptionId: "follow_0",
            hashes: [blockHash],
          },
        },
      },
      {
        ids: CHAIN_CONTINUE_HEAD,
        codec: VersionedRemoteChainHeadContinueRequest,
        request: {
          tag: "V1",
          value: {
            genesisHash,
            followSubscriptionId: "follow_0",
            operationId: "operation-1",
          },
        },
      },
      {
        ids: CHAIN_STOP_HEAD_OPERATION,
        codec: VersionedRemoteChainHeadStopOperationRequest,
        request: {
          tag: "V1",
          value: {
            genesisHash,
            followSubscriptionId: "follow_0",
            operationId: "operation-1",
          },
        },
      },
    ] as const;

    for (const [index, item] of cases.entries()) {
      // When
      harness.emit(
        followBoundFrame(
          `request-${index}`,
          item.ids,
          item.codec as Codec<FollowBoundRequest>,
          item.request,
        ),
      );

      // Then
      expect(
        decodedFollowId(
          harness.received.at(-1)!,
          item.codec as Codec<FollowBoundRequest>,
        ),
      ).toBe("wire-follow");
    }
  });

  it("As a dotli integrator, the host retains the first follow until that exact subscription stops", () => {
    // Given
    const harness = createHarness();
    const request = {
      tag: "V1",
      value: { genesisHash, followSubscriptionId: "follow_0", hash: blockHash },
    } as const;
    const emitHeader = (): string => {
      harness.emit(
        followBoundFrame(
          "header-request",
          CHAIN_GET_HEAD_HEADER,
          VersionedRemoteChainHeadHeaderRequest,
          request,
        ),
      );
      return decodedFollowId(
        harness.received.at(-1)!,
        VersionedRemoteChainHeadHeaderRequest,
      );
    };

    // When
    harness.emit(followStart("wire-first"));
    harness.emit(followStart("wire-second"));

    // Then
    expect(emitHeader()).toBe("wire-first");

    // When
    harness.emit(followStop("wire-second"));

    // Then
    expect(emitHeader()).toBe("wire-first");

    // When
    harness.emit(followStop("wire-first"));

    // Then
    expect(emitHeader()).toBe("follow_0");

    // When
    harness.emit(followStart("wire-refollow"));

    // Then
    expect(emitHeader()).toBe("wire-refollow");
  });

  it("As a dotli integrator, the host forgets a follow interrupted by the core", () => {
    // Given
    const harness = createHarness();
    const request = {
      tag: "V1",
      value: { genesisHash, followSubscriptionId: "follow_0", hash: blockHash },
    } as const;

    // When
    harness.emit(followStart("wire-old"));
    harness.adapted.postMessage(
      frame(
        "wire-old",
        CHAIN_FOLLOW_HEAD_SUBSCRIBE,
        MESSAGE_TYPE_INTERRUPT,
        new Uint8Array(),
      ),
    );
    harness.emit(followStart("wire-new"));
    harness.emit(
      followBoundFrame(
        "header-request",
        CHAIN_GET_HEAD_HEADER,
        VersionedRemoteChainHeadHeaderRequest,
        request,
      ),
    );

    // Then
    expect(harness.sent).toHaveLength(1);
    expect(
      decodedFollowId(
        harness.received.at(-1)!,
        VersionedRemoteChainHeadHeaderRequest,
      ),
    ).toBe("wire-new");
  });

  it("As a dotli integrator, the host drops stale follows when a reloaded iframe handshakes", () => {
    // Given
    const harness = createHarness();
    const request = {
      tag: "V1",
      value: { genesisHash, followSubscriptionId: "follow_0", hash: blockHash },
    } as const;

    // When
    harness.emit(followStart("wire-old"));
    harness.emit(
      frame(
        "handshake",
        SYSTEM_HANDSHAKE,
        MESSAGE_TYPE_REQUEST,
        new Uint8Array(),
      ),
    );
    harness.emit(followStart("wire-new"));
    harness.emit(
      followBoundFrame(
        "header-request",
        CHAIN_GET_HEAD_HEADER,
        VersionedRemoteChainHeadHeaderRequest,
        request,
      ),
    );

    // Then
    expect(
      decodedFollowId(
        harness.received.at(-1)!,
        VersionedRemoteChainHeadHeaderRequest,
      ),
    ).toBe("wire-new");
  });

  it("As a dotli integrator, the host routes each follow-bound request to its own concurrent follow", () => {
    // Given: two concurrent follows on the same genesis (PAPI opens a fresh
    // follow during resync before stopping the previous one), which Nova
    // exposes to the product as follow_0 and follow_1.
    const harness = createHarness();
    harness.emit(followStart("wire-follow-a"));
    harness.emit(followStart("wire-follow-b"));

    const emitHeader = (syntheticId: string, requestId: string): string => {
      harness.emit(
        followBoundFrame(
          requestId,
          CHAIN_GET_HEAD_HEADER,
          VersionedRemoteChainHeadHeaderRequest,
          {
            tag: "V1",
            value: {
              genesisHash,
              followSubscriptionId: syntheticId,
              hash: blockHash,
            },
          },
        ),
      );
      return decodedFollowId(
        harness.received.at(-1)!,
        VersionedRemoteChainHeadHeaderRequest,
      );
    };

    // Then: each op reaches the follow it is bound to, not the first active.
    expect(emitHeader("follow_0", "op-0")).toBe("wire-follow-a");
    expect(emitHeader("follow_1", "op-1")).toBe("wire-follow-b");

    // When the older follow stops, follow_1 ops still reach their follow.
    harness.emit(followStop("wire-follow-a"));

    // Then
    expect(emitHeader("follow_1", "op-2")).toBe("wire-follow-b");

    // Then: a synthetic id the shim never saw falls back to the first
    // active follow instead of passing through unmapped.
    expect(emitHeader("follow_9", "op-3")).toBe("wire-follow-b");
  });

  it("As a dotli integrator, the host keeps mirroring Nova's follow numbering across a full stop", () => {
    // Given: Nova's synthetic counter never resets within a connection, so a
    // follow started after every earlier follow stopped is follow_1, not
    // follow_0.
    const harness = createHarness();
    harness.emit(followStart("wire-follow-a"));
    harness.emit(followStop("wire-follow-a"));
    harness.emit(followStart("wire-follow-b"));
    harness.emit(followStart("wire-follow-c"));

    const emitHeader = (syntheticId: string, requestId: string): string => {
      harness.emit(
        followBoundFrame(
          requestId,
          CHAIN_GET_HEAD_HEADER,
          VersionedRemoteChainHeadHeaderRequest,
          {
            tag: "V1",
            value: {
              genesisHash,
              followSubscriptionId: syntheticId,
              hash: blockHash,
            },
          },
        ),
      );
      return decodedFollowId(
        harness.received.at(-1)!,
        VersionedRemoteChainHeadHeaderRequest,
      );
    };

    // Then: ops route by Nova's numbering, not a restarted count.
    expect(emitHeader("follow_1", "op-0")).toBe("wire-follow-b");
    expect(emitHeader("follow_2", "op-1")).toBe("wire-follow-c");
  });

  it("As a dotli integrator, the host owns and disposes the wrapped provider", () => {
    // Given
    const harness = createHarness();

    // When
    harness.adapted.dispose();

    // Then
    expect(harness.dispose).toHaveBeenCalledOnce();
  });
});
