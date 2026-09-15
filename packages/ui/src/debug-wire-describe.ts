// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import * as WIRE_TABLE from "@parity/truapi/wire-table";
import { WIRE_DECODE_TABLE } from "@parity/truapi/wire-decode";
import {
  MESSAGE_TYPE_REQUEST,
  MESSAGE_TYPE_RESPONSE,
  MESSAGE_TYPE_INTERRUPT,
  MESSAGE_TYPE_STOP,
  VersionedHostRequestResourceAllocationRequest,
  VersionedHostRequestResourceAllocationResponse,
  VersionedHostRequestResourceAllocationError,
  type Payload,
} from "@parity/truapi";
import { CallError, Result } from "@parity/truapi/scale";

// These names are consumed by the panel's chain annotations and swimlanes.
// Payload codecs come from codegen, not a second hand-maintained codec registry.
const CHAIN_STEMS: Partial<Record<keyof typeof WIRE_TABLE, string>> = {
  CHAIN_FOLLOW_HEAD_SUBSCRIBE: "head_follow",
  CHAIN_GET_HEAD_HEADER: "head_header",
  CHAIN_GET_HEAD_BODY: "head_body",
  CHAIN_GET_HEAD_STORAGE: "head_storage",
  CHAIN_CALL_HEAD: "head_call",
  CHAIN_UNPIN_HEAD: "head_unpin",
  CHAIN_CONTINUE_HEAD: "head_continue",
  CHAIN_STOP_HEAD_OPERATION: "head_stop_operation",
  CHAIN_GET_SPEC_GENESIS_HASH: "spec_genesis_hash",
  CHAIN_GET_SPEC_CHAIN_NAME: "spec_chain_name",
  CHAIN_GET_SPEC_PROPERTIES: "spec_properties",
  CHAIN_GET_CHAIN_INFO: "info",
  CHAIN_BROADCAST_TRANSACTION: "transaction_broadcast",
  CHAIN_STOP_TRANSACTION: "transaction_stop",
};
const REDACTED_PREFIXES = ["signing", "session", "entropy", "local_storage"];
const methods = new Map(
  Object.entries(WIRE_TABLE).map(([name, ids]) => {
    const chainStem = CHAIN_STEMS[name as keyof typeof WIRE_TABLE];
    const tag =
      chainStem === undefined
        ? name.toLowerCase()
        : `remote_chain_${chainStem}`;
    return [
      ids.trait * 256 + ids.method,
      {
        tag,
        kind: ids.kind,
        chain: chainStem !== undefined,
        redacted: REDACTED_PREFIXES.some((prefix) => tag.startsWith(prefix)),
      },
    ];
  }),
);
const allocationResponseCodec = Result(
  VersionedHostRequestResourceAllocationResponse,
  CallError(VersionedHostRequestResourceAllocationError),
);

export function describeWireFrame(payload: Payload): {
  tag: string;
  value: unknown;
} {
  const { traitId, methodId, messageType, value: bytes } = payload;
  const address = traitId * 256 + methodId;
  const method = methods.get(address);
  const role =
    messageType === MESSAGE_TYPE_REQUEST
      ? method?.kind === "subscription"
        ? "start"
        : "request"
      : messageType === MESSAGE_TYPE_RESPONSE
        ? method?.kind === "subscription"
          ? "receive"
          : "response"
        : messageType === MESSAGE_TYPE_INTERRUPT &&
            method?.kind === "subscription"
          ? "interrupt"
          : messageType === MESSAGE_TYPE_STOP && method?.kind === "subscription"
            ? "stop"
            : undefined;
  const tag =
    method === undefined || role === undefined
      ? `wire_${String(traitId)}_${String(methodId)}_${String(messageType)}`
      : `${method.tag}_${role}`;
  // Keep wireId for the panel's raw-payload guard, but include all scoped fields.
  const raw = { wireId: address, traitId, methodId, messageType, bytes };
  const redacted = { redacted: true, byteLength: bytes.length };
  if (method?.redacted === true) {
    return { tag, value: redacted };
  }

  // Allocation selectors/outcomes are inspector metadata. Do not retain error
  // reasons, trailing bytes, or malformed/unknown legs for this method.
  if (
    traitId === WIRE_TABLE.RESOURCE_ALLOCATION_REQUEST.trait &&
    methodId === WIRE_TABLE.RESOURCE_ALLOCATION_REQUEST.method
  ) {
    try {
      if (messageType === MESSAGE_TYPE_REQUEST) {
        const request =
          VersionedHostRequestResourceAllocationRequest.dec(bytes);
        const encoded =
          VersionedHostRequestResourceAllocationRequest.enc(request);
        if (
          encoded.length === bytes.length &&
          encoded.every((byte, i) => byte === bytes[i])
        ) {
          return { tag, value: { resources: request.value.resources } };
        }
      } else if (messageType === MESSAGE_TYPE_RESPONSE) {
        const response = allocationResponseCodec.dec(bytes);
        const encoded = allocationResponseCodec.enc(response);
        if (
          encoded.length === bytes.length &&
          encoded.every((byte, i) => byte === bytes[i])
        ) {
          return {
            tag,
            value: response.success
              ? { outcomes: response.value.value.outcomes }
              : { failed: true },
          };
        }
      }
    } catch {
      // Debugging must never break delivery or expose malformed metadata.
      return { tag, value: redacted };
    }
    return { tag, value: redacted };
  }

  const decode =
    method?.chain === true
      ? WIRE_DECODE_TABLE[address][messageType]
      : undefined;
  if (decode !== undefined) {
    try {
      const value = decode(bytes);
      if (messageType === MESSAGE_TYPE_RESPONSE && method?.kind === "request") {
        // Codec 2 is Result<VersionedResponse, CallError<VersionedError>>.
        // The panel consumes Result<bare response, error>; unwrap only Ok.
        const result = value as { success: boolean; value: { value: unknown } };
        return {
          tag,
          value: result.success
            ? { success: true, value: result.value.value }
            : result,
        };
      }
      return { tag, value };
    } catch {
      // A malformed chain frame stays opaque and cannot break transport.
      return { tag, value: raw };
    }
  }
  return { tag, value: raw };
}
