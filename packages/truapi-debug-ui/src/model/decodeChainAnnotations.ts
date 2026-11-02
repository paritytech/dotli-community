// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A frame that arrives undecoded keeps the raw `{ wireId, bytes }` shape and stays opaque here.

import { CHAIN_FOLLOW_RECEIVE_TAG, CHAIN_FOLLOW_START_TAG } from './chainFollowTags.js';
import { isUint8ArrayLike } from './isUint8ArrayLike.js';
import { toEnumValue, toRecord, toStringValue, peelVersion } from './shape.js';

export type ChainKind =
  | 'follow-start'
  | 'follow-receive'
  | 'head-header-request'
  | 'head-header-response'
  | 'head-body-request'
  | 'head-body-response'
  | 'head-storage-request'
  | 'head-storage-response'
  | 'head-call-request'
  | 'head-call-response'
  | 'head-unpin-request'
  | 'head-unpin-response'
  | 'head-continue-request'
  | 'head-continue-response'
  | 'head-stop-op-request'
  | 'head-stop-op-response'
  | 'spec-genesis-hash-request'
  | 'spec-genesis-hash-response'
  | 'spec-chain-name-request'
  | 'spec-chain-name-response'
  | 'spec-properties-request'
  | 'spec-properties-response'
  | 'tx-broadcast-request'
  | 'tx-broadcast-response'
  | 'tx-stop-request'
  | 'tx-stop-response';

/** Undefined on request, start and receive messages. */
export type ChainOutcome =
  | 'ok'
  /** An operation will stream results through the follow subscription, or a broadcast was accepted. */
  | 'started'
  /** The node refused a new operation at its resource limit. */
  | 'limit-reached'
  | 'error';

export type ChainAnnotations = {
  kind: ChainKind;
  genesisHash?: string | undefined;
  followSubscriptionId?: string | undefined;
  /** Set by the node on body/storage/call starts and reused by continue/stop. Also tracks a broadcast. */
  operationId?: string | undefined;
  blockHash?: string | undefined;
  /** The ChainHeadEvent variant tag, set only for `follow-receive`. */
  chainEventTag?: string | undefined;
  outcome?: ChainOutcome;
  errorMessage?: string | undefined;
};

type ResultValue<Success, Failure> = { success: true; value: Success } | { success: false; value: Failure };

/**
 * Null for messages outside `remote_chain_*`.
 * A payload arrives without its method envelope, so only the version envelope remains.
 */
export function decodeChainAnnotations(tag: string, rawPayload: unknown): ChainAnnotations | null {
  if (isRawWirePayload(rawPayload)) {
    return null;
  }
  const payload = peelVersion(rawPayload);
  switch (tag) {
    case CHAIN_FOLLOW_START_TAG: {
      const record = toRecord(payload);
      return {
        kind: 'follow-start',
        genesisHash: toStringValue(record?.['genesisHash']),
      };
    }
    case CHAIN_FOLLOW_RECEIVE_TAG: {
      const followEvent = toEnumValue(payload);
      const eventValue = toRecord(followEvent?.value);
      return {
        kind: 'follow-receive',
        chainEventTag: followEvent?.tag,
        operationId: toStringValue(eventValue?.['operationId']),
      };
    }

    case 'remote_chain_head_header_request':
      return decodeOperationRequest('head-header-request', payload);
    case 'remote_chain_head_header_response':
      return decodeSimpleResponse('head-header-response', payload);

    case 'remote_chain_head_body_request':
      return decodeOperationRequest('head-body-request', payload);
    case 'remote_chain_head_body_response':
      return decodeOperationStarterResponse('head-body-response', payload);

    case 'remote_chain_head_storage_request':
      return decodeOperationRequest('head-storage-request', payload);
    case 'remote_chain_head_storage_response':
      return decodeOperationStarterResponse('head-storage-response', payload);

    case 'remote_chain_head_call_request':
      return decodeOperationRequest('head-call-request', payload);
    case 'remote_chain_head_call_response':
      return decodeOperationStarterResponse('head-call-response', payload);

    case 'remote_chain_head_unpin_request':
      return decodeOperationRequest('head-unpin-request', payload);
    case 'remote_chain_head_unpin_response':
      return decodeSimpleResponse('head-unpin-response', payload);

    case 'remote_chain_head_continue_request':
      return decodeOperationControl('head-continue-request', payload);
    case 'remote_chain_head_continue_response':
      return decodeSimpleResponse('head-continue-response', payload);

    case 'remote_chain_head_stop_operation_request':
      return decodeOperationControl('head-stop-op-request', payload);
    case 'remote_chain_head_stop_operation_response':
      return decodeSimpleResponse('head-stop-op-response', payload);

    case 'remote_chain_spec_genesis_hash_request':
      return decodeSpecRequest('spec-genesis-hash-request', payload);
    case 'remote_chain_spec_genesis_hash_response':
      return decodeSimpleResponse('spec-genesis-hash-response', payload);

    case 'remote_chain_spec_chain_name_request':
      return decodeSpecRequest('spec-chain-name-request', payload);
    case 'remote_chain_spec_chain_name_response':
      return decodeSimpleResponse('spec-chain-name-response', payload);

    case 'remote_chain_spec_properties_request':
      return decodeSpecRequest('spec-properties-request', payload);
    case 'remote_chain_spec_properties_response':
      return decodeSimpleResponse('spec-properties-response', payload);

    case 'remote_chain_transaction_broadcast_request': {
      const record = toRecord(payload);
      return {
        kind: 'tx-broadcast-request',
        genesisHash: toStringValue(record?.['genesisHash']),
      };
    }
    case 'remote_chain_transaction_broadcast_response':
      return decodeBroadcastResponse(payload);
    case 'remote_chain_transaction_stop_request': {
      const record = toRecord(payload);
      return {
        kind: 'tx-stop-request',
        genesisHash: toStringValue(record?.['genesisHash']),
        operationId: toStringValue(record?.['operationId']),
      };
    }
    case 'remote_chain_transaction_stop_response':
      return decodeSimpleResponse('tx-stop-response', payload);

    default:
      return null;
  }
}

function isRawWirePayload(payload: unknown): boolean {
  const record = toRecord(payload);
  return typeof record?.['wireId'] === 'number' && isUint8ArrayLike(record['bytes']);
}

function readResult(payload: unknown): ResultValue<unknown, unknown> {
  // The payload parse is held, so a response payload is taken to be its call's result.
  return payload as ResultValue<unknown, unknown>;
}

function decodeOperationRequest(kind: ChainKind, payload: unknown): ChainAnnotations {
  const record = toRecord(payload);
  return {
    kind,
    genesisHash: toStringValue(record?.['genesisHash']),
    followSubscriptionId: toStringValue(record?.['followSubscriptionId']),
    // unpin carries plural `hashes`, left out because one slot would misrepresent many blocks.
    blockHash: toStringValue(record?.['hash']),
  };
}

function decodeSpecRequest(kind: ChainKind, payload: unknown): ChainAnnotations {
  const record = toRecord(payload);
  return {
    kind,
    genesisHash: toStringValue(payload) ?? toStringValue(record?.['genesisHash']),
  };
}

function decodeOperationControl(kind: ChainKind, payload: unknown): ChainAnnotations {
  const record = toRecord(payload);
  return {
    kind,
    genesisHash: toStringValue(record?.['genesisHash']),
    followSubscriptionId: toStringValue(record?.['followSubscriptionId']),
    operationId: toStringValue(record?.['operationId']),
  };
}

function decodeSimpleResponse(kind: ChainKind, payload: unknown): ChainAnnotations {
  const result = readResult(payload);
  if (!result.success) {
    return toErrorAnnotations(kind, result.value);
  }
  return { kind, outcome: 'ok' };
}

function decodeBroadcastResponse(payload: unknown): ChainAnnotations {
  const kind = 'tx-broadcast-response';
  const result = readResult(payload);
  if (!result.success) {
    return toErrorAnnotations(kind, result.value);
  }
  const operationId = toStringValue(result.value) ?? toStringValue(toRecord(result.value)?.['operationId']);
  // Without an operationId the node hit its limit.
  if (operationId === undefined) {
    return { kind, outcome: 'limit-reached' };
  }
  return { kind, operationId, outcome: 'started' };
}

function decodeOperationStarterResponse(kind: ChainKind, payload: unknown): ChainAnnotations {
  const result = readResult(payload);
  if (!result.success) {
    return toErrorAnnotations(kind, result.value);
  }
  const struct = toRecord(result.value);
  const inner = toEnumValue(struct?.['operation']) ?? toEnumValue(result.value);
  if (inner === undefined) {
    return { kind, outcome: 'ok' };
  }
  if (inner.tag === 'Started') {
    const innerValue = toRecord(inner.value);
    return {
      kind,
      outcome: 'started',
      operationId: toStringValue(innerValue?.['operationId']),
    };
  }
  if (inner.tag === 'LimitReached') {
    return { kind, outcome: 'limit-reached' };
  }
  return { kind, outcome: 'ok' };
}

function toErrorAnnotations(kind: ChainKind, error: unknown): ChainAnnotations {
  return { kind, outcome: 'error', errorMessage: extractErrorReason(error) };
}

function extractErrorReason(error: unknown): string | undefined {
  const record = toRecord(error);
  if (record === undefined) {
    return undefined;
  }
  const tagged = extractTaggedReason(record);
  if (tagged !== undefined) {
    return tagged;
  }
  const payload = toRecord(record['payload']);
  const reason = toStringValue(payload?.['reason']) ?? toStringValue(record['reason']);
  if (reason !== undefined) {
    return reason;
  }
  const message = toStringValue(record['message']);
  return message === undefined || message === '' ? undefined : message;
}

/** `Denied` and `Unsupported` carry no payload, so their tag is the reason. */
function extractTaggedReason(record: Record<string, unknown>): string | undefined {
  const tag = toStringValue(record['tag']);
  if (tag === undefined) {
    return undefined;
  }
  switch (tag) {
    case 'Domain':
      return toStringValue(toRecord(peelVersion(record['value']))?.['reason']);
    case 'MalformedFrame':
    case 'HostFailure':
      return toStringValue(toRecord(record['value'])?.['reason']);
    case 'Denied':
    case 'Unsupported':
      return tag;
    default:
      return undefined;
  }
}
