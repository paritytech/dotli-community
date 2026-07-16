import { describe, expect, it, vi } from "vitest";
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
import { createLegacyNovaChainHeadProvider } from "@dotli/ui/legacy-host-bridge";

const genesisHash = `0x${"11".repeat(32)}` as const;
const blockHash = `0x${"22".repeat(32)}` as const;

type FollowBoundRequest = {
  tag: "V1";
  value: {
    genesisHash: string;
    followSubscriptionId: string;
  };
};

function unwrap<T>(result: { isErr(): boolean; value: T; error: unknown }): T {
  if (result.isErr()) {
    throw result.error;
  }
  return result.value;
}

function createHarness(): {
  adapted: WireProvider;
  emit(message: Uint8Array): void;
  received: Uint8Array[];
  dispose: ReturnType<typeof vi.fn>;
} {
  let listener: ((message: Uint8Array) => void) | undefined;
  const dispose = vi.fn();
  const provider: WireProvider = {
    postMessage: vi.fn(),
    subscribe(callback) {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    dispose,
  };
  const adapted = createLegacyNovaChainHeadProvider(provider);
  const received: Uint8Array[] = [];
  adapted.subscribe((message) => received.push(message));
  return {
    adapted,
    emit(message) {
      listener?.(message);
    },
    received,
    dispose,
  };
}

function frame(requestId: string, id: number, value: Uint8Array): Uint8Array {
  return unwrap(
    encodeWireMessage({
      requestId,
      payload: { id, value },
    }),
  );
}

function followStart(requestId: string): Uint8Array {
  return frame(
    requestId,
    CHAIN_FOLLOW_HEAD_SUBSCRIBE.start,
    VersionedRemoteChainHeadFollowRequest.enc({
      tag: "V1",
      value: { genesisHash, withRuntime: true },
    }),
  );
}

function followStop(requestId: string): Uint8Array {
  return frame(requestId, CHAIN_FOLLOW_HEAD_SUBSCRIBE.stop, new Uint8Array());
}

function followBoundFrame<T extends FollowBoundRequest>(
  requestId: string,
  id: number,
  codec: Codec<T>,
  request: T,
): Uint8Array {
  return frame(requestId, id, codec.enc(request));
}

function decodedFollowId<T extends FollowBoundRequest>(
  message: Uint8Array,
  codec: Codec<T>,
): string {
  const decoded = unwrap(decodeWireMessage(message));
  return codec.dec(decoded.payload.value).value.followSubscriptionId;
}

describe("createLegacyNovaChainHeadProvider", () => {
  it("rewrites every follow-bound request to the active wire follow id", () => {
    const harness = createHarness();
    harness.emit(followStart("wire-follow"));

    const cases = [
      {
        id: CHAIN_GET_HEAD_HEADER.request,
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
        id: CHAIN_GET_HEAD_BODY.request,
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
        id: CHAIN_GET_HEAD_STORAGE.request,
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
        id: CHAIN_CALL_HEAD.request,
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
        id: CHAIN_UNPIN_HEAD.request,
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
        id: CHAIN_CONTINUE_HEAD.request,
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
        id: CHAIN_STOP_HEAD_OPERATION.request,
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
      harness.emit(
        followBoundFrame(
          `request-${index}`,
          item.id,
          item.codec as Codec<FollowBoundRequest>,
          item.request,
        ),
      );
      expect(
        decodedFollowId(
          harness.received.at(-1)!,
          item.codec as Codec<FollowBoundRequest>,
        ),
      ).toBe("wire-follow");
    }
  });

  it("retains the first follow until that exact subscription stops", () => {
    const harness = createHarness();
    const request = {
      tag: "V1",
      value: { genesisHash, followSubscriptionId: "follow_0", hash: blockHash },
    } as const;
    const emitHeader = (): string => {
      harness.emit(
        followBoundFrame(
          "header-request",
          CHAIN_GET_HEAD_HEADER.request,
          VersionedRemoteChainHeadHeaderRequest,
          request,
        ),
      );
      return decodedFollowId(
        harness.received.at(-1)!,
        VersionedRemoteChainHeadHeaderRequest,
      );
    };

    harness.emit(followStart("wire-first"));
    harness.emit(followStart("wire-second"));
    expect(emitHeader()).toBe("wire-first");

    harness.emit(followStop("wire-second"));
    expect(emitHeader()).toBe("wire-first");

    harness.emit(followStop("wire-first"));
    expect(emitHeader()).toBe("follow_0");

    harness.emit(followStart("wire-refollow"));
    expect(emitHeader()).toBe("wire-refollow");
  });

  it("owns and disposes the wrapped provider", () => {
    const harness = createHarness();

    harness.adapted.dispose();

    expect(harness.dispose).toHaveBeenCalledOnce();
  });
});
