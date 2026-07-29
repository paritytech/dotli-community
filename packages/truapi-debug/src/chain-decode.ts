// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// TrUAPI chain message decoder
//
// Pure function that takes a TrUAPI payload tag (e.g.
// `remote_chain_head_body_request`) plus an already-decoded value and returns
// the JSON-RPC-level correlation keys the event carries: `genesisHash`,
// `followSubscriptionId`, `operationId`, `blockHash`, and (for follow receive
// events) the ChainHeadEvent variant tag.
//
// The debug tap (`packages/ui/src/debug-wire-describe.ts`) already decodes
// chain frames before they reach this module. A frame whose codec failed to
// decode, or that has no registered codec, still carries the raw
// `{ wireId, bytes }` shape. Those stay opaque and `isRawWirePayload`
// returns null for them instead of guessing.
//
// Shapes mirror the TrUAPI chain callback payloads.

import { asEnum, asObj, asString, peelVersion } from "./shape.ts";

/** High-level categorisation of a chain message. Direction (request vs
 *  response vs subscription start/receive) is already known from the
 *  TrUAPI event's `direction` field, so kinds collapse both sides of a
 *  flow into one enum here. */
export type ChainKind =
  | "follow-start"
  | "follow-receive"
  | "head-header-request"
  | "head-header-response"
  | "head-body-request"
  | "head-body-response"
  | "head-storage-request"
  | "head-storage-response"
  | "head-call-request"
  | "head-call-response"
  | "head-unpin-request"
  | "head-unpin-response"
  | "head-continue-request"
  | "head-continue-response"
  | "head-stop-op-request"
  | "head-stop-op-response"
  | "spec-genesis-hash-request"
  | "spec-genesis-hash-response"
  | "spec-chain-name-request"
  | "spec-chain-name-response"
  | "spec-properties-request"
  | "spec-properties-response"
  | "tx-broadcast-request"
  | "tx-broadcast-response"
  | "tx-stop-request"
  | "tx-stop-response";

/** Outcome annotation for response messages. Undefined on request/start/receive. */
export type ChainOutcome =
  /** Plain successful response (header/unpin/continue/stop/spec/tx-stop). */
  | "ok"
  /** An operation was accepted and will stream results through the follow
   *  subscription (body/storage/call) OR a transaction broadcast accepted. */
  | "started"
  /** Node refused to launch a new operation because of resource limits. */
  | "limit-reached"
  /** Response carried a GenericError. `errorMessage` holds the reason. */
  | "error";

export interface ChainAnnotations {
  kind: ChainKind;
  genesisHash?: string;
  /** For operation requests: which follow subscription the op targets. */
  followSubscriptionId?: string;
  /** Operation-level correlation id. Set by the node for body/storage/call
   *  starts, echoed in their result events, and reused in continue/stop.
   *  Also the tracking id for transaction broadcast/stop. */
  operationId?: string;
  blockHash?: string;
  /** Only set for `follow-receive`: the ChainHeadEvent variant tag
   *  (`Initialized`, `NewBlock`, `BestBlockChanged`, `Finalized`,
   *  `OperationBodyDone`, `OperationCallDone`, `OperationStorageItems`,
   *  `OperationStorageDone`, `OperationWaitingForContinue`,
   *  `OperationInaccessible`, `OperationError`, `Stop`). */
  chainEventTag?: string;
  outcome?: ChainOutcome;
  errorMessage?: string;
}

type ResultValue<T, E> =
  | { success: true; value: T }
  | { success: false; value: E };

/**
 * Extract chain-protocol annotations from a TrUAPI message.
 * Returns `null` for messages outside the `remote_chain_*` namespace.
 *
 * Each method's payload arrives in a version envelope like
 * `{tag: "V1", value: <inner>}`. The generated codecs emit uppercase `V1`
 * and the pre-port lowercase `v1` is still tolerated. The event store
 * already peeled the outer method envelope, so only the version envelope
 * is peeled here before decoding.
 */
export function decodeChainAnnotations(
  tag: string,
  rawPayload: unknown,
): ChainAnnotations | null {
  if (isRawWirePayload(rawPayload)) {
    return null;
  }
  const payload = peelVersion(rawPayload);
  switch (tag) {
    // chainHead.follow subscription
    case "remote_chain_head_follow_start": {
      const p = asObj(payload);
      return {
        kind: "follow-start",
        genesisHash: asString(p?.genesisHash),
      };
    }
    case "remote_chain_head_follow_receive": {
      const ev = asEnum(payload);
      const eventValue = asObj(ev?.value);
      return {
        kind: "follow-receive",
        chainEventTag: ev?.tag,
        // Only operation variants carry an operationId. The rest (Initialized,
        // NewBlock, Finalized, Stop) leave it undefined.
        operationId: asString(eventValue?.operationId),
      };
    }

    // chainHead.header
    case "remote_chain_head_header_request":
      return opRequest("head-header-request", payload);
    case "remote_chain_head_header_response":
      return simpleResponse("head-header-response", payload);

    // chainHead.body / storage / call (operation-starting)
    case "remote_chain_head_body_request":
      return opRequest("head-body-request", payload);
    case "remote_chain_head_body_response":
      return operationStarterResponse("head-body-response", payload);

    case "remote_chain_head_storage_request":
      return opRequest("head-storage-request", payload);
    case "remote_chain_head_storage_response":
      return operationStarterResponse("head-storage-response", payload);

    case "remote_chain_head_call_request":
      return opRequest("head-call-request", payload);
    case "remote_chain_head_call_response":
      return operationStarterResponse("head-call-response", payload);

    // chainHead.unpin / continue / stopOperation
    case "remote_chain_head_unpin_request":
      return opRequest("head-unpin-request", payload);
    case "remote_chain_head_unpin_response":
      return simpleResponse("head-unpin-response", payload);

    case "remote_chain_head_continue_request": {
      const p = asObj(payload);
      return {
        kind: "head-continue-request",
        genesisHash: asString(p?.genesisHash),
        followSubscriptionId: asString(p?.followSubscriptionId),
        operationId: asString(p?.operationId),
      };
    }
    case "remote_chain_head_continue_response":
      return simpleResponse("head-continue-response", payload);

    case "remote_chain_head_stop_operation_request": {
      const p = asObj(payload);
      return {
        kind: "head-stop-op-request",
        genesisHash: asString(p?.genesisHash),
        followSubscriptionId: asString(p?.followSubscriptionId),
        operationId: asString(p?.operationId),
      };
    }
    case "remote_chain_head_stop_operation_response":
      return simpleResponse("head-stop-op-response", payload);

    // chainSpec.*
    case "remote_chain_spec_genesis_hash_request":
      return specRequest("spec-genesis-hash-request", payload);
    case "remote_chain_spec_genesis_hash_response":
      return simpleResponse("spec-genesis-hash-response", payload);

    case "remote_chain_spec_chain_name_request":
      return specRequest("spec-chain-name-request", payload);
    case "remote_chain_spec_chain_name_response":
      return simpleResponse("spec-chain-name-response", payload);

    case "remote_chain_spec_properties_request":
      return specRequest("spec-properties-request", payload);
    case "remote_chain_spec_properties_response":
      return simpleResponse("spec-properties-response", payload);

    // transaction.broadcast / stop
    case "remote_chain_transaction_broadcast_request": {
      const p = asObj(payload);
      return {
        kind: "tx-broadcast-request",
        genesisHash: asString(p?.genesisHash),
      };
    }
    case "remote_chain_transaction_broadcast_response": {
      // The Ok value is `{ operationId?: string }`. With an operationId the
      // broadcast started, without one the node hit its limit. A bare string
      // is tolerated in case a producer already unwrapped the field.
      const r = payload as ResultValue<unknown, unknown>;
      if (r.success) {
        const opId = asString(r.value) ?? asString(asObj(r.value)?.operationId);
        if (opId !== undefined) {
          return {
            kind: "tx-broadcast-response",
            operationId: opId,
            outcome: "started",
          };
        }
        return {
          kind: "tx-broadcast-response",
          outcome: "limit-reached",
        };
      }
      return {
        kind: "tx-broadcast-response",
        outcome: "error",
        errorMessage: extractErrorReason(r.value),
      };
    }
    case "remote_chain_transaction_stop_request": {
      const p = asObj(payload);
      return {
        kind: "tx-stop-request",
        genesisHash: asString(p?.genesisHash),
        operationId: asString(p?.operationId),
      };
    }
    case "remote_chain_transaction_stop_response":
      return simpleResponse("tx-stop-response", payload);

    default:
      return null;
  }
}

function isRawWirePayload(payload: unknown): boolean {
  const obj = asObj(payload);
  return (
    typeof obj?.wireId === "number" &&
    (obj.bytes instanceof Uint8Array ||
      (typeof obj.bytes === "object" &&
        obj.bytes !== null &&
        (obj.bytes as { constructor?: { name?: string } }).constructor?.name ===
          "Uint8Array"))
  );
}

/**
 * Human-readable label for a row, derived from the annotations. The
 * original TrUAPI method tag stays available on the event, so this label
 * is for scannable display. Direction is conveyed separately by the
 * row's arrow, so the label focuses on what the call *is*.
 */
export function formatChainLabel(ann: ChainAnnotations): string {
  switch (ann.kind) {
    case "follow-start":
      return "chainHead.follow";
    case "follow-receive":
      return ann.chainEventTag === undefined
        ? "chainHead.follow"
        : `chainHead.follow · ${ann.chainEventTag}`;
    case "head-header-request":
    case "head-header-response":
      return "chainHead.header";
    case "head-body-request":
    case "head-body-response":
      return "chainHead.body";
    case "head-storage-request":
    case "head-storage-response":
      return "chainHead.storage";
    case "head-call-request":
    case "head-call-response":
      return "chainHead.call";
    case "head-unpin-request":
    case "head-unpin-response":
      return "chainHead.unpin";
    case "head-continue-request":
    case "head-continue-response":
      return "chainHead.continue";
    case "head-stop-op-request":
    case "head-stop-op-response":
      return "chainHead.stopOperation";
    case "spec-genesis-hash-request":
    case "spec-genesis-hash-response":
      return "chainSpec.genesisHash";
    case "spec-chain-name-request":
    case "spec-chain-name-response":
      return "chainSpec.chainName";
    case "spec-properties-request":
    case "spec-properties-response":
      return "chainSpec.properties";
    case "tx-broadcast-request":
    case "tx-broadcast-response":
      return "transaction.broadcast";
    case "tx-stop-request":
    case "tx-stop-response":
      return "transaction.stop";
  }
}

/** Common shape for header/body/storage/call/unpin requests. */
function opRequest(kind: ChainKind, payload: unknown): ChainAnnotations {
  const p = asObj(payload);
  return {
    kind,
    genesisHash: asString(p?.genesisHash),
    followSubscriptionId: asString(p?.followSubscriptionId),
    // unpin has `hashes` (plural) rather than a single `hash`. We leave
    // blockHash undefined there. unpin typically covers many blocks and
    // a single-slot display would misrepresent that.
    blockHash: asString(p?.hash),
  };
}

/** Spec requests are structs in the generated codecs. The pre-port shape
 *  was a bare genesisHash string, still tolerated here. */
function specRequest(kind: ChainKind, payload: unknown): ChainAnnotations {
  const p = asObj(payload);
  return {
    kind,
    genesisHash: asString(payload) ?? asString(p?.genesisHash),
  };
}

/** For header/unpin/continue/stop_op/spec/tx_stop: Result<T, GenericError>
 *  where T isn't interesting enough to annotate beyond success/failure. */
function simpleResponse(kind: ChainKind, payload: unknown): ChainAnnotations {
  const r = payload as ResultValue<unknown, unknown>;
  if (!r.success) {
    return {
      kind,
      outcome: "error",
      errorMessage: extractErrorReason(r.value),
    };
  }
  return { kind, outcome: "ok" };
}

/** Body/storage/call responses wrap the operation enum in a struct, e.g.
 *  `{ operation: OperationStartedResult }` with variants Started{operationId}
 *  and LimitReached. A bare enum is tolerated in case a producer already
 *  unwrapped the `operation` field. */
function operationStarterResponse(
  kind: ChainKind,
  payload: unknown,
): ChainAnnotations {
  const r = payload as ResultValue<unknown, unknown>;
  if (!r.success) {
    return {
      kind,
      outcome: "error",
      errorMessage: extractErrorReason(r.value),
    };
  }
  const struct = asObj(r.value);
  const inner = asEnum(struct?.operation) ?? asEnum(r.value);
  if (inner === undefined) {
    // Unknown shape, but the response was still a success. Report ok.
    return { kind, outcome: "ok" };
  }
  if (inner.tag === "Started") {
    const innerVal = asObj(inner.value);
    return {
      kind,
      outcome: "started",
      operationId: asString(innerVal?.operationId),
    };
  }
  if (inner.tag === "LimitReached") {
    return { kind, outcome: "limit-reached" };
  }
  // Unknown variant, but still a success. Report ok.
  return { kind, outcome: "ok" };
}

/**
 * Errors arrive as `CallError` variants. `Domain` wraps the method's own
 * versioned error, so peel it to reach `{ reason }`. `MalformedFrame` and
 * `HostFailure` carry a `{ reason }` directly. `Denied` and `Unsupported`
 * have no payload, so the tag is the best available reason.
 */
function extractErrorReason(v: unknown): string | undefined {
  const o = asObj(v);
  if (o === undefined) {
    return undefined;
  }
  if (typeof o.tag === "string") {
    switch (o.tag) {
      case "Domain": {
        const domain = asObj(peelVersion(o.value));
        const reason = asString(domain?.reason);
        if (reason !== undefined) {
          return reason;
        }
        break;
      }
      case "MalformedFrame":
      case "HostFailure": {
        const reason = asString(asObj(o.value)?.reason);
        if (reason !== undefined) {
          return reason;
        }
        break;
      }
      case "Denied":
      case "Unsupported":
        return o.tag;
      default:
        break;
    }
  }
  // Older and ad-hoc error shapes: `.payload.reason`, a top-level
  // `.reason`, or an Error's `.message` as a last resort.
  const payload = asObj(o.payload);
  const reason = asString(payload?.reason) ?? asString(o.reason);
  if (reason !== undefined) {
    return reason;
  }
  const message = asString(o.message);
  return message === undefined || message === "" ? undefined : message;
}
