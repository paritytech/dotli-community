import { describe, expect, it } from "vitest";
import {
  GenericError,
  VersionedHostRequestResourceAllocationRequest,
  VersionedHostRequestResourceAllocationResponse,
  VersionedHostRequestResourceAllocationError,
  VersionedRemoteChainHeadBodyResponse,
  VersionedRemoteChainHeadBodyError,
  VersionedRemoteChainHeadFollowRequest,
  VersionedRemoteChainHeadHeaderRequest,
  VersionedRemoteChainHeadHeaderResponse,
  VersionedRemoteChainHeadHeaderError,
  VersionedRemoteChainHeadUnpinResponse,
  VersionedRemoteChainHeadUnpinError,
  MESSAGE_TYPE_REQUEST,
  MESSAGE_TYPE_RESPONSE,
  MESSAGE_TYPE_INTERRUPT,
  MESSAGE_TYPE_STOP,
  type MethodIds,
} from "@parity/truapi";
import { CallError, Result, _void } from "@parity/truapi/scale";
import * as W from "@parity/truapi/wire-table";
import { describeWireFrame } from "@dotli/ui/debug-wire-describe";
import { decodeChainAnnotations } from "@dotli/truapi-debug/chain-decode";
import { blockHash, genesisHash } from "./support.ts";

function describeFrame(ids: MethodIds, messageType: number, value: Uint8Array) {
  return describeWireFrame({
    traitId: ids.trait,
    methodId: ids.method,
    messageType,
    value,
  });
}

const allocationResponseCodec = Result(
  VersionedHostRequestResourceAllocationResponse,
  CallError(VersionedHostRequestResourceAllocationError),
);
const headerResponseCodec = Result(
  VersionedRemoteChainHeadHeaderResponse,
  CallError(VersionedRemoteChainHeadHeaderError),
);

describe("describeWireFrame", () => {
  it("preserves batched resource selectors and outcomes in request order", () => {
    const resources = [
      { tag: "StatementStoreAllowance", value: undefined },
      { tag: "BulletinAllowance", value: undefined },
    ] as const;
    const request = VersionedHostRequestResourceAllocationRequest.enc({
      tag: "V1",
      value: { resources: [...resources] },
    });
    const response = allocationResponseCodec.enc({
      success: true,
      value: { tag: "V1", value: { outcomes: ["Rejected", "Allocated"] } },
    });
    expect(
      describeFrame(
        W.RESOURCE_ALLOCATION_REQUEST,
        MESSAGE_TYPE_REQUEST,
        request,
      ).value,
    ).toEqual({ resources });
    expect(
      describeFrame(
        W.RESOURCE_ALLOCATION_REQUEST,
        MESSAGE_TYPE_RESPONSE,
        response,
      ).value,
    ).toEqual({ outcomes: ["Rejected", "Allocated"] });
  });

  it("redacts malformed allocation data, unknown legs and private failure reasons", () => {
    const request = VersionedHostRequestResourceAllocationRequest.enc({
      tag: "V1",
      value: {
        resources: [{ tag: "StatementStoreAllowance", value: undefined }],
      },
    });
    const privateBytes = new TextEncoder().encode("not-for-the-activity-log");
    const trailing = new Uint8Array([...request, ...privateBytes]);
    const malformed = new Uint8Array([255, ...privateBytes]);
    expect(
      describeFrame(
        W.RESOURCE_ALLOCATION_REQUEST,
        MESSAGE_TYPE_REQUEST,
        trailing,
      ).value,
    ).toEqual({ redacted: true, byteLength: trailing.length });
    expect(
      describeFrame(
        W.RESOURCE_ALLOCATION_REQUEST,
        MESSAGE_TYPE_RESPONSE,
        malformed,
      ).value,
    ).toEqual({ redacted: true, byteLength: malformed.length });
    expect(
      describeFrame(
        W.RESOURCE_ALLOCATION_REQUEST,
        MESSAGE_TYPE_INTERRUPT,
        privateBytes,
      ).value,
    ).toEqual({ redacted: true, byteLength: privateBytes.length });
    const failure = allocationResponseCodec.enc({
      success: false,
      value: { tag: "HostFailure", value: { reason: "private reason" } },
    });
    expect(
      describeFrame(
        W.RESOURCE_ALLOCATION_REQUEST,
        MESSAGE_TYPE_RESPONSE,
        failure,
      ).value,
    ).toEqual({ failed: true });
  });

  it("keeps chain start and follow request correlation consumable by the panel", () => {
    const start = describeFrame(
      W.CHAIN_FOLLOW_HEAD_SUBSCRIBE,
      MESSAGE_TYPE_REQUEST,
      VersionedRemoteChainHeadFollowRequest.enc({
        tag: "V1",
        value: { genesisHash, withRuntime: true },
      }),
    );
    expect(decodeChainAnnotations(start.tag, start.value)).toEqual({
      kind: "follow-start",
      genesisHash,
    });
    const request = describeFrame(
      W.CHAIN_GET_HEAD_HEADER,
      MESSAGE_TYPE_REQUEST,
      VersionedRemoteChainHeadHeaderRequest.enc({
        tag: "V1",
        value: { genesisHash, followSubscriptionId: "p:1", hash: blockHash },
      }),
    );
    expect(decodeChainAnnotations(request.tag, request.value)).toEqual({
      kind: "head-header-request",
      genesisHash,
      followSubscriptionId: "p:1",
      blockHash,
    });
  });

  it("decodes codec-2 Ok and Err payloads into panel response outcomes", () => {
    const ok = describeFrame(
      W.CHAIN_GET_HEAD_HEADER,
      MESSAGE_TYPE_RESPONSE,
      headerResponseCodec.enc({
        success: true,
        value: { tag: "V1", value: { header: blockHash } },
      }),
    );
    expect(ok.value).toEqual({ success: true, value: { header: blockHash } });
    expect(decodeChainAnnotations(ok.tag, ok.value)).toEqual({
      kind: "head-header-response",
      outcome: "ok",
    });
    const failure = describeFrame(
      W.CHAIN_GET_HEAD_HEADER,
      MESSAGE_TYPE_RESPONSE,
      headerResponseCodec.enc({
        success: false,
        value: {
          tag: "Domain",
          value: { tag: "V1", value: { reason: "unknown block" } },
        },
      }),
    );
    expect(decodeChainAnnotations(failure.tag, failure.value)).toEqual({
      kind: "head-header-response",
      outcome: "error",
      errorMessage: "unknown block",
    });
    const unpin = describeFrame(
      W.CHAIN_UNPIN_HEAD,
      MESSAGE_TYPE_RESPONSE,
      Result(
        VersionedRemoteChainHeadUnpinResponse,
        CallError(VersionedRemoteChainHeadUnpinError),
      ).enc({ success: true, value: { tag: "V1", value: undefined } }),
    );
    expect(decodeChainAnnotations(unpin.tag, unpin.value)).toEqual({
      kind: "head-unpin-response",
      outcome: "ok",
    });
  });
  it("retains operation IDs from versioned Ok values for follow-event correlation", () => {
    const response = describeFrame(
      W.CHAIN_GET_HEAD_BODY,
      MESSAGE_TYPE_RESPONSE,
      Result(
        VersionedRemoteChainHeadBodyResponse,
        CallError(VersionedRemoteChainHeadBodyError),
      ).enc({
        success: true,
        value: {
          tag: "V1",
          value: {
            operation: {
              tag: "Started",
              value: { operationId: "operation-7" },
            },
          },
        },
      }),
    );
    expect(decodeChainAnnotations(response.tag, response.value)).toEqual({
      kind: "head-body-response",
      outcome: "started",
      operationId: "operation-7",
    });
  });

  it("classifies and decodes typed subscription interrupts separately from stop", () => {
    const reason = {
      success: false,
      value: { tag: "HostFailure", value: { reason: "chain unavailable" } },
    } as const;
    const interrupt = describeFrame(
      W.CHAIN_FOLLOW_HEAD_SUBSCRIBE,
      MESSAGE_TYPE_INTERRUPT,
      Result(_void, CallError(GenericError)).enc(reason),
    );
    expect(interrupt).toEqual({
      tag: "remote_chain_head_follow_interrupt",
      value: reason,
    });
    const stop = describeFrame(
      W.CHAIN_FOLLOW_HEAD_SUBSCRIBE,
      MESSAGE_TYPE_STOP,
      new Uint8Array(),
    );
    expect(stop).toEqual({
      tag: "remote_chain_head_follow_stop",
      value: undefined,
    });
  });

  it("does not confuse equal method IDs in different traits or request/subscription legs", () => {
    const bytes = new Uint8Array([255]);
    const handshake = describeFrame(
      W.SYSTEM_HANDSHAKE,
      MESSAGE_TYPE_REQUEST,
      bytes,
    );
    const follow = describeFrame(
      W.CHAIN_FOLLOW_HEAD_SUBSCRIBE,
      MESSAGE_TYPE_REQUEST,
      bytes,
    );
    expect(handshake.tag).toBe("system_handshake_request");
    expect(follow.tag).toBe("remote_chain_head_follow_start");
    expect(decodeChainAnnotations(follow.tag, follow.value)).toBeNull();
    const unknown = describeWireFrame({
      traitId: 250,
      methodId: 1,
      messageType: 0,
      value: bytes,
    });
    expect(unknown).toEqual({
      tag: "wire_250_1_0",
      value: {
        wireId: 64001,
        traitId: 250,
        methodId: 1,
        messageType: 0,
        bytes,
      },
    });
  });

  it("never exposes sensitive family bytes, including unknown message legs", () => {
    const bytes = new Uint8Array(48);
    for (const messageType of [MESSAGE_TYPE_REQUEST, 255]) {
      const value = describeFrame(
        W.LOCAL_STORAGE_READ,
        messageType,
        bytes,
      ).value;
      expect(value).toEqual({ redacted: true, byteLength: 48 });
    }
  });
});
