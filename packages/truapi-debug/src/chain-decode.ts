// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Frames the debug tap could not decode keep the raw `{ wireId, bytes }` shape and stay opaque here.

import { asEnum, asObj, asString, peelVersion } from './shape.js';

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

export interface ChainAnnotations {
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
}

type ResultValue<T, E> = { success: true; value: T } | { success: false; value: E };

/**
 * Null for messages outside `remote_chain_*`.
 * The event store already peeled the method envelope, so only the version envelope remains.
 */
export function decodeChainAnnotations(tag: string, rawPayload: unknown): ChainAnnotations | null {
  if (isRawWirePayload(rawPayload)) {
    return null;
  }
  const payload = peelVersion(rawPayload);
  switch (tag) {
    case 'remote_chain_head_follow_start': {
      const p = asObj(payload);
      return {
        kind: 'follow-start',
        genesisHash: asString(p?.['genesisHash']),
      };
    }
    case 'remote_chain_head_follow_receive': {
      const ev = asEnum(payload);
      const eventValue = asObj(ev?.value);
      return {
        kind: 'follow-receive',
        chainEventTag: ev?.tag,
        operationId: asString(eventValue?.['operationId']),
      };
    }

    case 'remote_chain_head_header_request':
      return opRequest('head-header-request', payload);
    case 'remote_chain_head_header_response':
      return simpleResponse('head-header-response', payload);

    case 'remote_chain_head_body_request':
      return opRequest('head-body-request', payload);
    case 'remote_chain_head_body_response':
      return operationStarterResponse('head-body-response', payload);

    case 'remote_chain_head_storage_request':
      return opRequest('head-storage-request', payload);
    case 'remote_chain_head_storage_response':
      return operationStarterResponse('head-storage-response', payload);

    case 'remote_chain_head_call_request':
      return opRequest('head-call-request', payload);
    case 'remote_chain_head_call_response':
      return operationStarterResponse('head-call-response', payload);

    case 'remote_chain_head_unpin_request':
      return opRequest('head-unpin-request', payload);
    case 'remote_chain_head_unpin_response':
      return simpleResponse('head-unpin-response', payload);

    case 'remote_chain_head_continue_request': {
      const p = asObj(payload);
      return {
        kind: 'head-continue-request',
        genesisHash: asString(p?.['genesisHash']),
        followSubscriptionId: asString(p?.['followSubscriptionId']),
        operationId: asString(p?.['operationId']),
      };
    }
    case 'remote_chain_head_continue_response':
      return simpleResponse('head-continue-response', payload);

    case 'remote_chain_head_stop_operation_request': {
      const p = asObj(payload);
      return {
        kind: 'head-stop-op-request',
        genesisHash: asString(p?.['genesisHash']),
        followSubscriptionId: asString(p?.['followSubscriptionId']),
        operationId: asString(p?.['operationId']),
      };
    }
    case 'remote_chain_head_stop_operation_response':
      return simpleResponse('head-stop-op-response', payload);

    case 'remote_chain_spec_genesis_hash_request':
      return specRequest('spec-genesis-hash-request', payload);
    case 'remote_chain_spec_genesis_hash_response':
      return simpleResponse('spec-genesis-hash-response', payload);

    case 'remote_chain_spec_chain_name_request':
      return specRequest('spec-chain-name-request', payload);
    case 'remote_chain_spec_chain_name_response':
      return simpleResponse('spec-chain-name-response', payload);

    case 'remote_chain_spec_properties_request':
      return specRequest('spec-properties-request', payload);
    case 'remote_chain_spec_properties_response':
      return simpleResponse('spec-properties-response', payload);

    case 'remote_chain_transaction_broadcast_request': {
      const p = asObj(payload);
      return {
        kind: 'tx-broadcast-request',
        genesisHash: asString(p?.['genesisHash']),
      };
    }
    case 'remote_chain_transaction_broadcast_response': {
      // Without an operationId the node hit its limit.
      const r = payload as ResultValue<unknown, unknown>;
      if (r.success) {
        const opId = asString(r.value) ?? asString(asObj(r.value)?.['operationId']);
        if (opId !== undefined) {
          return {
            kind: 'tx-broadcast-response',
            operationId: opId,
            outcome: 'started',
          };
        }
        return {
          kind: 'tx-broadcast-response',
          outcome: 'limit-reached',
        };
      }
      return {
        kind: 'tx-broadcast-response',
        outcome: 'error',
        errorMessage: extractErrorReason(r.value),
      };
    }
    case 'remote_chain_transaction_stop_request': {
      const p = asObj(payload);
      return {
        kind: 'tx-stop-request',
        genesisHash: asString(p?.['genesisHash']),
        operationId: asString(p?.['operationId']),
      };
    }
    case 'remote_chain_transaction_stop_response':
      return simpleResponse('tx-stop-response', payload);

    default:
      return null;
  }
}

function isRawWirePayload(payload: unknown): boolean {
  const obj = asObj(payload);
  return (
    typeof obj?.['wireId'] === 'number' &&
    (obj['bytes'] instanceof Uint8Array ||
      (typeof obj['bytes'] === 'object' &&
        obj['bytes'] !== null &&
        (obj['bytes'] as { constructor?: { name?: string } }).constructor?.name === 'Uint8Array'))
  );
}

/** Direction shows in the row's arrow, so the label names only the call. */
export function formatChainLabel(ann: ChainAnnotations): string {
  switch (ann.kind) {
    case 'follow-start':
      return 'chainHead.follow';
    case 'follow-receive':
      return ann.chainEventTag === undefined ? 'chainHead.follow' : `chainHead.follow · ${ann.chainEventTag}`;
    case 'head-header-request':
    case 'head-header-response':
      return 'chainHead.header';
    case 'head-body-request':
    case 'head-body-response':
      return 'chainHead.body';
    case 'head-storage-request':
    case 'head-storage-response':
      return 'chainHead.storage';
    case 'head-call-request':
    case 'head-call-response':
      return 'chainHead.call';
    case 'head-unpin-request':
    case 'head-unpin-response':
      return 'chainHead.unpin';
    case 'head-continue-request':
    case 'head-continue-response':
      return 'chainHead.continue';
    case 'head-stop-op-request':
    case 'head-stop-op-response':
      return 'chainHead.stopOperation';
    case 'spec-genesis-hash-request':
    case 'spec-genesis-hash-response':
      return 'chainSpec.genesisHash';
    case 'spec-chain-name-request':
    case 'spec-chain-name-response':
      return 'chainSpec.chainName';
    case 'spec-properties-request':
    case 'spec-properties-response':
      return 'chainSpec.properties';
    case 'tx-broadcast-request':
    case 'tx-broadcast-response':
      return 'transaction.broadcast';
    case 'tx-stop-request':
    case 'tx-stop-response':
      return 'transaction.stop';
  }
}

function opRequest(kind: ChainKind, payload: unknown): ChainAnnotations {
  const p = asObj(payload);
  return {
    kind,
    genesisHash: asString(p?.['genesisHash']),
    followSubscriptionId: asString(p?.['followSubscriptionId']),
    // unpin carries plural `hashes`, left out because one slot would misrepresent many blocks.
    blockHash: asString(p?.['hash']),
  };
}

function specRequest(kind: ChainKind, payload: unknown): ChainAnnotations {
  const p = asObj(payload);
  return {
    kind,
    genesisHash: asString(payload) ?? asString(p?.['genesisHash']),
  };
}

function simpleResponse(kind: ChainKind, payload: unknown): ChainAnnotations {
  const r = payload as ResultValue<unknown, unknown>;
  if (!r.success) {
    return {
      kind,
      outcome: 'error',
      errorMessage: extractErrorReason(r.value),
    };
  }
  return { kind, outcome: 'ok' };
}

function operationStarterResponse(kind: ChainKind, payload: unknown): ChainAnnotations {
  const r = payload as ResultValue<unknown, unknown>;
  if (!r.success) {
    return {
      kind,
      outcome: 'error',
      errorMessage: extractErrorReason(r.value),
    };
  }
  const struct = asObj(r.value);
  const inner = asEnum(struct?.['operation']) ?? asEnum(r.value);
  if (inner === undefined) {
    return { kind, outcome: 'ok' };
  }
  if (inner.tag === 'Started') {
    const innerVal = asObj(inner.value);
    return {
      kind,
      outcome: 'started',
      operationId: asString(innerVal?.['operationId']),
    };
  }
  if (inner.tag === 'LimitReached') {
    return { kind, outcome: 'limit-reached' };
  }
  return { kind, outcome: 'ok' };
}

/** `Denied` and `Unsupported` carry no payload, so their tag is the reason. */
function extractErrorReason(v: unknown): string | undefined {
  const o = asObj(v);
  if (o === undefined) {
    return undefined;
  }
  if (typeof o['tag'] === 'string') {
    switch (o['tag']) {
      case 'Domain': {
        const domain = asObj(peelVersion(o['value']));
        const reason = asString(domain?.['reason']);
        if (reason !== undefined) {
          return reason;
        }
        break;
      }
      case 'MalformedFrame':
      case 'HostFailure': {
        const reason = asString(asObj(o['value'])?.['reason']);
        if (reason !== undefined) {
          return reason;
        }
        break;
      }
      case 'Denied':
      case 'Unsupported':
        return o['tag'];
      default:
        break;
    }
  }
  const payload = asObj(o['payload']);
  const reason = asString(payload?.['reason']) ?? asString(o['reason']);
  if (reason !== undefined) {
    return reason;
  }
  const message = asString(o['message']);
  return message === undefined || message === '' ? undefined : message;
}
