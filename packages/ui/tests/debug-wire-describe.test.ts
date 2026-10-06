import { describe, expect, it } from "vitest";
import {
  decodeWireMessage,
  encodeWireMessage,
  VersionedRemoteChainTransactionBroadcastResponse,
  VersionedRemoteChainTransactionBroadcastError,
  VersionedRemoteChainHeadBodyResponse,
  VersionedRemoteChainHeadBodyError,
  VersionedRemoteChainHeadHeaderResponse,
  VersionedRemoteChainHeadFollowRequest,
  VersionedRemoteChainHeadHeaderError,
  VersionedRemoteChainHeadHeaderRequest,
  VersionedRemoteChainHeadUnpinError,
  type MethodIds,
  type Payload,
} from "@parity/truapi";
import { CallError, Result, _void } from "@parity/truapi/scale";
import * as WIRE_TABLE from "@parity/truapi/wire-table";
import {
  CHAIN_FOLLOW_HEAD_SUBSCRIBE,
  CHAIN_BROADCAST_TRANSACTION,
  CHAIN_GET_HEAD_HEADER,
  CHAIN_GET_HEAD_BODY,
  CHAIN_UNPIN_HEAD,
  LOCAL_STORAGE_READ,
  SYSTEM_HANDSHAKE,
} from "@parity/truapi/wire-table";
import { describeWireFrame, __testing } from "@dotli/ui/debug-wire-describe";
import { decodeChainAnnotations } from "@dotli/truapi-debug/chain-decode";
import { blockHash, genesisHash, unwrap } from "./support.ts";

function frame(
  method: MethodIds,
  messageType: number,
  value: Uint8Array,
): Payload {
  return { traitId: method.trait, methodId: method.method, messageType, value };
}

describe("describeWireFrame", () => {
  it("decodes current chain subscription frames while retaining panel tags", () => {
    const value = {
      tag: "V1" as const,
      value: { genesisHash, withRuntime: true },
    };
    const payload = frame(
      CHAIN_FOLLOW_HEAD_SUBSCRIBE,
      0,
      VersionedRemoteChainHeadFollowRequest.enc(value),
    );
    const encoded = unwrap(encodeWireMessage({ requestId: "req-1", payload }));
    expect(
      describeWireFrame(unwrap(decodeWireMessage(encoded)).payload),
    ).toEqual({ tag: "remote_chain_head_follow_start", value });
  });

  it("keeps chain request correlation fields intact", () => {
    const value = {
      tag: "V1" as const,
      value: { genesisHash, followSubscriptionId: "follow_0", hash: blockHash },
    };
    expect(
      describeWireFrame(
        frame(
          CHAIN_GET_HEAD_HEADER,
          0,
          VersionedRemoteChainHeadHeaderRequest.enc(value),
        ),
      ),
    ).toEqual({ tag: "remote_chain_head_header_request", value });
  });

  it("names ordinary frames and preserves raw bytes", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(describeWireFrame(frame(SYSTEM_HANDSHAKE, 0, bytes))).toEqual({
      tag: "system_handshake_request",
      value: { wireId: 65536, bytes },
    });
  });

  it("retains the sensitive-family redaction policy", () => {
    expect(
      describeWireFrame(frame(LOCAL_STORAGE_READ, 0, new Uint8Array(48))),
    ).toEqual({
      tag: "local_storage_read_request",
      value: { redacted: true, byteLength: 48 },
    });
  });

  it("preserves unknown addresses and malformed payloads as bytes", () => {
    const bytes = new Uint8Array([255]);
    expect(
      describeWireFrame({
        traitId: 250,
        methodId: 123,
        messageType: 7,
        value: bytes,
      }),
    ).toEqual({ tag: "wire_16415495", value: { wireId: 16415495, bytes } });
    expect(describeWireFrame(frame(CHAIN_GET_HEAD_HEADER, 0, bytes))).toEqual({
      tag: "remote_chain_head_header_request",
      value: { wireId: 196864, bytes },
    });
  });

  it("decodes the current Result<VersionedResponse, CallError> success and refusal", () => {
    const codec = Result(
      VersionedRemoteChainHeadHeaderResponse,
      CallError(VersionedRemoteChainHeadHeaderError),
    );
    const accepted = {
      success: true as const,
      value: { tag: "V1" as const, value: { header: blockHash } },
    };
    const denied = {
      success: false as const,
      value: {
        tag: "Domain" as const,
        value: { tag: "V1" as const, value: { reason: "unknown block" } },
      },
    };
    expect(
      [accepted, denied].map((value) =>
        describeWireFrame(frame(CHAIN_GET_HEAD_HEADER, 1, codec.enc(value))),
      ),
    ).toEqual(
      [accepted, denied].map((value) => ({
        tag: "remote_chain_head_header_response",
        value,
      })),
    );
  });

  it("decodes void results without adding a version envelope", () => {
    const codec = Result(_void, CallError(VersionedRemoteChainHeadUnpinError));
    const value = { success: true as const, value: undefined };
    expect(
      describeWireFrame(frame(CHAIN_UNPIN_HEAD, 1, codec.enc(value))),
    ).toEqual({ tag: "remote_chain_head_unpin_response", value });
  });

  it("keeps current chain operation responses correlated in the panel", () => {
    const codec = Result(
      VersionedRemoteChainHeadBodyResponse,
      CallError(VersionedRemoteChainHeadBodyError),
    );
    const value = {
      success: true as const,
      value: {
        tag: "V1" as const,
        value: {
          operation: {
            tag: "Started" as const,
            value: { operationId: "body-1" },
          },
        },
      },
    };
    const described = describeWireFrame(
      frame(CHAIN_GET_HEAD_BODY, 1, codec.enc(value)),
    );
    expect(decodeChainAnnotations(described.tag, described.value)).toEqual({
      kind: "head-body-response",
      outcome: "started",
      operationId: "body-1",
    });
  });

  it("keeps current transaction broadcast responses correlated in the panel", () => {
    const codec = Result(
      VersionedRemoteChainTransactionBroadcastResponse,
      CallError(VersionedRemoteChainTransactionBroadcastError),
    );
    const described = describeWireFrame(
      frame(
        CHAIN_BROADCAST_TRANSACTION,
        1,
        codec.enc({
          success: true,
          value: { tag: "V1", value: { operationId: "broadcast-1" } },
        }),
      ),
    );
    expect(decodeChainAnnotations(described.tag, described.value)).toEqual({
      kind: "tx-broadcast-response",
      outcome: "started",
      operationId: "broadcast-1",
    });
  });

  it("keeps subscription stop and interrupt in the chain lane", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(
      [3, 2].map((kind) =>
        describeWireFrame(frame(CHAIN_FOLLOW_HEAD_SUBSCRIBE, kind, bytes)),
      ),
    ).toEqual([
      {
        tag: "remote_chain_head_follow_stop",
        value: { wireId: 196611, bytes },
      },
      {
        tag: "remote_chain_head_follow_interrupt",
        value: { wireId: 196610, bytes },
      },
    ]);
  });
});

// The linkage table (`CHAIN_LINKAGE`) is the one hand-maintained fact
// bridging a wire-table entry to its generated codec family. Everything
// else is derived. These tests fail the moment that derivation stops
// matching the installed `@parity/truapi`: a new codegen chain method with
// no linkage row, a renamed codec export, or a stem typo that would
// silently shift the panel's tag vocabulary.
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
      // Given: the shape (subscription vs call) the wire table declares for
      // this row, read through the same discriminant production uses.
      const roles = __testing.wireRoles(WIRE_TABLE[wireTableKey]);

      // When / Then: a codegen rename of any expected export fails here
      // instead of silently mis-decoding or falling back to raw bytes.
      if (__testing.isSubscriptionRoles(roles)) {
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
            __testing.resolveCodec(`VersionedRemoteChain${stem}Response`),
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

    // Then: pins the exact current 16-entry legacy vocabulary as a literal
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
      "remote_chain_info",
      "remote_chain_transaction_broadcast",
      "remote_chain_transaction_stop",
      "remote_chain_head_follow_stop",
      "remote_chain_head_follow_interrupt",
    ]);
  });
});
