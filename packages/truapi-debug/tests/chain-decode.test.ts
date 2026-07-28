// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { decodeChainAnnotations } from "../src/chain-decode.ts";

const genesisHash = `0x${"11".repeat(32)}`;

describe("decodeChainAnnotations", () => {
  it("As a dotli integrator, the host peels the generated codecs' uppercase V1 envelope", () => {
    // Given: a follow-start payload exactly as the tap now emits it.
    const payload = {
      tag: "V1",
      value: { genesisHash, withRuntime: true },
    };

    // When
    const ann = decodeChainAnnotations(
      "remote_chain_head_follow_start",
      payload,
    );

    // Then
    expect(ann).toEqual({
      kind: "follow-start",
      genesisHash,
    });
  });

  it("As a dotli integrator, the host still peels the pre-port lowercase v1 envelope", () => {
    // Given
    const payload = { tag: "v1", value: { genesisHash } };

    // When
    const ann = decodeChainAnnotations(
      "remote_chain_head_follow_start",
      payload,
    );

    // Then
    expect(ann?.genesisHash).toBe(genesisHash);
  });

  it("As a dotli integrator, the host reads struct-wrapped spec-request genesis hashes", () => {
    // Given: generated codecs wrap the request in a struct, not a bare string.
    const payload = { tag: "V1", value: { genesisHash } };

    // When
    const ann = decodeChainAnnotations(
      "remote_chain_spec_genesis_hash_request",
      payload,
    );

    // Then
    expect(ann).toEqual({
      kind: "spec-genesis-hash-request",
      genesisHash,
    });
  });

  it("As a dotli integrator, the host extracts operation correlation from V1 follow events", () => {
    // Given: an OperationBodyDone event streamed on the follow subscription.
    const payload = {
      tag: "V1",
      value: { tag: "OperationBodyDone", value: { operationId: "op-1" } },
    };

    // When
    const ann = decodeChainAnnotations(
      "remote_chain_head_follow_receive",
      payload,
    );

    // Then
    expect(ann).toEqual({
      kind: "follow-receive",
      chainEventTag: "OperationBodyDone",
      operationId: "op-1",
    });
  });

  it("As a dotli integrator, the host reports 'ok' for a real header response shape (V1-tagged Result of the bare response struct)", () => {
    // Given: the exact decoded shape `describeWireFrame`'s response codec now
    // produces — `indexedTaggedUnion({ V1: [0, Result(bare, CallError(...))] })`.
    const payload = {
      tag: "V1",
      value: {
        success: true,
        value: { header: `0x${"22".repeat(32)}` },
      },
    };

    // When
    const ann = decodeChainAnnotations(
      "remote_chain_head_header_response",
      payload,
    );

    // Then
    expect(ann).toEqual({ kind: "head-header-response", outcome: "ok" });
  });

  it("As a dotli integrator, the host reports 'ok' for a void unpin response", () => {
    // Given: Result(_void, ...) decodes success with an undefined value.
    const payload = { tag: "V1", value: { success: true, value: undefined } };

    // When
    const ann = decodeChainAnnotations(
      "remote_chain_head_unpin_response",
      payload,
    );

    // Then
    expect(ann).toEqual({ kind: "head-unpin-response", outcome: "ok" });
  });

  it("As a dotli integrator, the host reports 'started' with operationId for a struct-wrapped operation-starter response", () => {
    // Given: RemoteChainHeadBodyResponse = { operation: OperationStartedResult }.
    const payload = {
      tag: "V1",
      value: {
        success: true,
        value: {
          operation: { tag: "Started", value: { operationId: "op-1" } },
        },
      },
    };

    // When
    const ann = decodeChainAnnotations(
      "remote_chain_head_body_response",
      payload,
    );

    // Then
    expect(ann).toEqual({
      kind: "head-body-response",
      outcome: "started",
      operationId: "op-1",
    });
  });

  it("As a dotli integrator, the host reports 'limit-reached' for a struct-wrapped LimitReached operation-starter response", () => {
    // Given
    const payload = {
      tag: "V1",
      value: {
        success: true,
        value: { operation: { tag: "LimitReached" } },
      },
    };

    // When
    const ann = decodeChainAnnotations(
      "remote_chain_head_storage_response",
      payload,
    );

    // Then
    expect(ann).toEqual({
      kind: "head-storage-response",
      outcome: "limit-reached",
    });
  });

  it("As a dotli integrator, the host reports 'error' with the Domain reason for a real CallError response", () => {
    // Given: CallError<VersionedRemoteChainHeadHeaderError> Domain variant,
    // wrapping the method's own versioned GenericError.
    const payload = {
      tag: "V1",
      value: {
        success: false,
        value: {
          tag: "Domain",
          value: { tag: "V1", value: { reason: "unknown block" } },
        },
      },
    };

    // When
    const ann = decodeChainAnnotations(
      "remote_chain_head_header_response",
      payload,
    );

    // Then
    expect(ann).toEqual({
      kind: "head-header-response",
      outcome: "error",
      errorMessage: "unknown block",
    });
  });

  it("As a dotli integrator, the host reports 'started' with operationId for a struct-wrapped transaction broadcast response", () => {
    // Given: RemoteChainTransactionBroadcastResponse = { operationId?: string }.
    const payload = {
      tag: "V1",
      value: { success: true, value: { operationId: "op-2" } },
    };

    // When
    const ann = decodeChainAnnotations(
      "remote_chain_transaction_broadcast_response",
      payload,
    );

    // Then
    expect(ann).toEqual({
      kind: "tx-broadcast-response",
      outcome: "started",
      operationId: "op-2",
    });
  });
});
