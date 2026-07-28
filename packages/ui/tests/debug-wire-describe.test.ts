import { describe, expect, it } from "vitest";
import {
  encodeWireMessage,
  RemoteChainHeadHeaderResponse,
  VersionedRemoteChainHeadFollowRequest,
  VersionedRemoteChainHeadHeaderError,
  VersionedRemoteChainHeadHeaderRequest,
  VersionedRemoteChainHeadUnpinError,
} from "@parity/truapi";
import {
  CallError,
  indexedTaggedUnion,
  Result,
  _void,
} from "@parity/truapi/scale";
import * as WIRE_TABLE from "@parity/truapi/wire-table";
import {
  CHAIN_FOLLOW_HEAD_SUBSCRIBE,
  CHAIN_GET_HEAD_HEADER,
  CHAIN_UNPIN_HEAD,
  LOCAL_STORAGE_READ,
  SYSTEM_HANDSHAKE,
} from "@parity/truapi/wire-table";
import { describeWireFrame, __testing } from "@dotli/ui/debug-wire-describe";

const genesisHash = `0x${"11".repeat(32)}`;
const blockHash = `0x${"22".repeat(32)}`;

function payloadBytes(
  codec: { enc: (v: never) => Uint8Array },
  value: unknown,
): Uint8Array {
  return codec.enc(value as never);
}

function unwrap<T>(r: { isErr(): boolean; value: T; error: unknown }): T {
  if (r.isErr()) {
    throw r.error;
  }
  return r.value;
}

describe("describeWireFrame", () => {
  it("As a dotli integrator, the host tags chain frames with the panel's legacy names and decodes their payloads", () => {
    // Given
    const bytes = payloadBytes(VersionedRemoteChainHeadFollowRequest, {
      tag: "V1",
      value: { genesisHash, withRuntime: true },
    });

    // When
    const described = describeWireFrame(
      CHAIN_FOLLOW_HEAD_SUBSCRIBE.start,
      bytes,
    );

    // Then
    expect(described.tag).toBe("remote_chain_head_follow_start");
    expect(described.value).toEqual({
      tag: "V1",
      value: { genesisHash, withRuntime: true },
    });
  });

  it("As a dotli integrator, the host decodes chain request payloads with correlation fields intact", () => {
    // Given
    const bytes = payloadBytes(VersionedRemoteChainHeadHeaderRequest, {
      tag: "V1",
      value: { genesisHash, followSubscriptionId: "follow_0", hash: blockHash },
    });

    // When
    const described = describeWireFrame(CHAIN_GET_HEAD_HEADER.request, bytes);

    // Then
    expect(described.tag).toBe("remote_chain_head_header_request");
    expect(
      (described.value as { value: { followSubscriptionId: string } }).value
        .followSubscriptionId,
    ).toBe("follow_0");
  });

  it("As a dotli integrator, the host names non-chain frames from the wire table without decoding them", () => {
    // Given: a system handshake frame (not in the codec registry).
    const bytes = new Uint8Array([1, 2, 3]);

    // When
    const described = describeWireFrame(SYSTEM_HANDSHAKE.request, bytes);

    // Then: mechanical name, raw payload preserved for the detail pane.
    expect(described.tag).toBe("system_handshake_request");
    expect(described.value).toEqual({
      wireId: SYSTEM_HANDSHAKE.request,
      bytes,
    });
  });

  it("As a dotli integrator, the host redacts sensitive families to metadata only", () => {
    // Given
    const bytes = new Uint8Array(48);

    // When
    const described = describeWireFrame(LOCAL_STORAGE_READ.request, bytes);

    // Then: named, but neither decoded value nor raw bytes escape the tap.
    expect(described.tag).toBe("local_storage_read_request");
    expect(described.value).toEqual({ redacted: true, byteLength: 48 });
  });

  it("As a dotli integrator, the host falls back to wire_<id> for unknown discriminants", () => {
    // Given
    const bytes = new Uint8Array([9]);

    // When
    const described = describeWireFrame(60_000, bytes);

    // Then
    expect(described.tag).toBe("wire_60000");
    expect(described.value).toEqual({ wireId: 60_000, bytes });
  });

  it("As a dotli integrator, the host degrades to raw bytes when a registered codec fails to decode", () => {
    // Given: garbage bytes on a chain discriminant.
    const bytes = new Uint8Array([0xff, 0xff, 0xff]);

    // When
    const described = describeWireFrame(CHAIN_GET_HEAD_HEADER.request, bytes);

    // Then: tag still resolves; payload keeps the raw form instead of throwing.
    expect(described.tag).toBe("remote_chain_head_header_request");
    expect(described.value).toEqual({
      wireId: CHAIN_GET_HEAD_HEADER.request,
      bytes,
    });
  });

  it("As a dotli integrator, the host encodes a full envelope round-trip the tap will perform", () => {
    // Given: the exact envelope the provider carries (guards Task 2's usage).
    const inner = payloadBytes(VersionedRemoteChainHeadFollowRequest, {
      tag: "V1",
      value: { genesisHash, withRuntime: true },
    });
    const framed = unwrap(
      encodeWireMessage({
        requestId: "req-1",
        payload: { id: CHAIN_FOLLOW_HEAD_SUBSCRIBE.start, value: inner },
      }),
    );

    // Then: sanity — the envelope encodes; Task 2 decodes it with decodeWireMessage.
    expect(framed).toBeInstanceOf(Uint8Array);
  });

  it("As a dotli integrator, the host decodes a real chainHead.header Ok response using the generated client's wire composition", () => {
    // Given: the exact composition `ChainClient#getHeadHeader` decodes with —
    // an indexed V1 envelope around Result(<bare response>, CallError(<error>)).
    // A bare `VersionedRemoteChainHeadHeaderResponse` codec (the old, wrong
    // registration) would silently decode this into garbage instead of the
    // real Result/CallError shape.
    const codec = indexedTaggedUnion({
      V1: [
        0,
        Result(
          RemoteChainHeadHeaderResponse,
          CallError(VersionedRemoteChainHeadHeaderError),
        ),
      ],
    });
    const bytes = payloadBytes(codec, {
      tag: "V1",
      value: { success: true, value: { header: blockHash } },
    });

    // When
    const described = describeWireFrame(CHAIN_GET_HEAD_HEADER.response, bytes);

    // Then
    expect(described.tag).toBe("remote_chain_head_header_response");
    expect(described.value).toEqual({
      tag: "V1",
      value: { success: true, value: { header: blockHash } },
    });
  });

  it("As a dotli integrator, the host decodes a real chainHead.header Err response using the generated client's wire composition", () => {
    // Given: a Domain error carrying the method's own versioned GenericError.
    const codec = indexedTaggedUnion({
      V1: [
        0,
        Result(
          RemoteChainHeadHeaderResponse,
          CallError(VersionedRemoteChainHeadHeaderError),
        ),
      ],
    });
    const bytes = payloadBytes(codec, {
      tag: "V1",
      value: {
        success: false,
        value: {
          tag: "Domain",
          value: { tag: "V1", value: { reason: "unknown block" } },
        },
      },
    });

    // When
    const described = describeWireFrame(CHAIN_GET_HEAD_HEADER.response, bytes);

    // Then
    expect(described.tag).toBe("remote_chain_head_header_response");
    expect(described.value).toEqual({
      tag: "V1",
      value: {
        success: false,
        value: {
          tag: "Domain",
          value: { tag: "V1", value: { reason: "unknown block" } },
        },
      },
    });
  });

  it("As a dotli integrator, the host decodes a real chainHead.unpin (void) Ok response using the generated client's wire composition", () => {
    // Given: `ChainClient#unpinHead` decodes with Result(_void, CallError(...)).
    const codec = indexedTaggedUnion({
      V1: [0, Result(_void, CallError(VersionedRemoteChainHeadUnpinError))],
    });
    const bytes = payloadBytes(codec, {
      tag: "V1",
      value: { success: true, value: undefined },
    });

    // When
    const described = describeWireFrame(CHAIN_UNPIN_HEAD.response, bytes);

    // Then
    expect(described.tag).toBe("remote_chain_head_unpin_response");
    expect(described.value).toEqual({
      tag: "V1",
      value: { success: true, value: undefined },
    });
  });

  it("As a dotli integrator, the host tags chainHead.follow stop/interrupt frames into the chain swimlane without decoding them", () => {
    // Given: control frames with no payload worth decoding.
    const stopBytes = new Uint8Array([1, 2, 3]);
    const interruptBytes = new Uint8Array([4, 5, 6]);

    // When
    const stop = describeWireFrame(CHAIN_FOLLOW_HEAD_SUBSCRIBE.stop, stopBytes);
    const interrupt = describeWireFrame(
      CHAIN_FOLLOW_HEAD_SUBSCRIBE.interrupt,
      interruptBytes,
    );

    // Then: legacy `remote_chain_*` tags so the swimlane layout keys on them,
    // raw bytes preserved since there's no codec for these.
    expect(stop.tag).toBe("remote_chain_head_follow_stop");
    expect(stop.value).toEqual({
      wireId: CHAIN_FOLLOW_HEAD_SUBSCRIBE.stop,
      bytes: stopBytes,
    });
    expect(interrupt.tag).toBe("remote_chain_head_follow_interrupt");
    expect(interrupt.value).toEqual({
      wireId: CHAIN_FOLLOW_HEAD_SUBSCRIBE.interrupt,
      bytes: interruptBytes,
    });
  });
});

// The chain-family registry's linkage table (`CHAIN_LINKAGE`) is the one
// hand-maintained fact bridging a wire-table entry to its generated codec
// family — everything else is derived. These tests fail loudly the moment
// that derivation stops matching the installed `@parity/truapi`: a new
// codegen chain method with no linkage row, a renamed codec export the
// registry can no longer resolve, or a stem typo that would silently shift
// the panel's tag vocabulary.
describe("chain-family drift guard", () => {
  it("As a dotli integrator, the host's linkage table covers every CHAIN_* wire-table export", () => {
    // Given: every chain wire-table export the installed `@parity/truapi` defines.
    const chainWireTableKeys = Object.keys(WIRE_TABLE).filter((key) =>
      key.startsWith("CHAIN_"),
    );

    // When
    const linkedKeys = __testing.CHAIN_LINKAGE.map((row) => row.wireTableKey);

    // Then: codegen adding a chain method with no linkage row fails here,
    // forcing a linkage row (and a redaction decision) before it ships.
    expect(new Set(linkedKeys)).toEqual(new Set(chainWireTableKeys));
    expect(linkedKeys).toHaveLength(chainWireTableKeys.length);
  });

  it.each(__testing.CHAIN_LINKAGE)(
    "As a dotli integrator, the host resolves every codec export linkage row $stem needs for its shape",
    ({ wireTableKey, stem }) => {
      // Given: the shape (subscription vs call) the wire table declares for this row.
      const roles = WIRE_TABLE[wireTableKey] as Record<string, number>;

      // When / Then: a codegen rename of any expected export fails here
      // instead of silently mis-decoding or falling back to raw bytes.
      if ("start" in roles) {
        expect(
          __testing.resolveCodec(`VersionedRemoteChain${stem}Request`),
        ).toBeDefined();
        expect(
          __testing.resolveCodec(`VersionedRemoteChain${stem}Item`),
        ).toBeDefined();
      } else {
        expect(
          __testing.resolveCodec(`VersionedRemoteChain${stem}Request`),
        ).toBeDefined();
        expect(
          __testing.resolveCodec(`VersionedRemoteChain${stem}Error`),
        ).toBeDefined();
        if (!__testing.VOID_RESPONSE_STEMS.has(stem)) {
          expect(
            __testing.resolveCodec(`RemoteChain${stem}Response`),
          ).toBeDefined();
        }
      }
    },
  );

  it("As a dotli integrator, the host derives the exact legacy tag vocabulary the panel's swimlane keys on", () => {
    // Given: the tag root every linkage row's stem derives (a stem typo here
    // would silently shift which swimlane a chain's frames land in), plus
    // the two `chainHead_follow` control tags that are full tags on their own.
    const derivedTagRoots = __testing.CHAIN_LINKAGE.map(
      ({ stem }) => `remote_chain_${__testing.snakeCase(stem)}`,
    );
    const controlOnlyTags = [
      "remote_chain_head_follow_stop",
      "remote_chain_head_follow_interrupt",
    ];

    // When
    const derived = [...derivedTagRoots, ...controlOnlyTags];

    // Then: pins the exact current 15-entry legacy vocabulary as a literal
    // snapshot, so it can't drift silently.
    expect(derived).toEqual([
      "remote_chain_head_follow",
      "remote_chain_head_header",
      "remote_chain_head_body",
      "remote_chain_head_storage",
      "remote_chain_head_call",
      "remote_chain_head_unpin",
      "remote_chain_head_continue",
      "remote_chain_head_stop_operation",
      "remote_chain_spec_genesis_hash",
      "remote_chain_spec_chain_name",
      "remote_chain_spec_properties",
      "remote_chain_transaction_broadcast",
      "remote_chain_transaction_stop",
      "remote_chain_head_follow_stop",
      "remote_chain_head_follow_interrupt",
    ]);
  });
});
