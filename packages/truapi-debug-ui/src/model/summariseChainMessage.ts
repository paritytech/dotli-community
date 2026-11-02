// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChainAnnotations } from './decodeChainAnnotations.js';
import { formatChainDisplay } from './formatChainDisplay.js';
import { formatCount } from './formatCount.js';
import { formatHexHeadAndTail } from './formatHexHeadAndTail.js';
import { formatIdHead } from './formatIdHead.js';
import { toEnumValue, toRecord, toStringValue, peelVersion } from './shape.js';

type Params = {
  annotations: ChainAnnotations;
  /** The payload with its version peeled. */
  inner: unknown;
  /** What was looked up, opening the sentence. */
  label: string;
};

/** One sentence on what a decoded chain message says, or null for a message it has no sentence for. Never throws. */
export function summariseChainMessage(annotations: ChainAnnotations, payload: unknown): string | null {
  const inner = peelVersion(payload);

  switch (annotations.kind) {
    case 'follow-start': {
      const record = toRecord(inner);
      const withRuntime = record?.['withRuntime'] === true;
      return `Subscribe to chain head${withRuntime ? ' (with runtime)' : ''}${formatChainSuffix(annotations.genesisHash)}.`;
    }
    case 'follow-receive':
      return summariseFollowEvent(inner);
    case 'head-header-request':
      return `Fetch header of block ${formatBlock(annotations.blockHash)}${formatFollowSuffix(annotations.followSubscriptionId)}.`;
    case 'head-header-response':
      return summariseHeaderResponse(annotations, inner);
    case 'head-body-request':
      return `Fetch body of block ${formatBlock(annotations.blockHash)}${formatFollowSuffix(annotations.followSubscriptionId)}.`;
    case 'head-body-response':
      return summariseOperationStarter(annotations, 'Body fetch');
    case 'head-storage-request':
      return summariseStorageRequest(annotations, inner);
    case 'head-storage-response':
      return summariseOperationStarter(annotations, 'Storage query');
    case 'head-call-request':
      return summariseCallRequest(annotations, inner);
    case 'head-call-response':
      return summariseOperationStarter(annotations, 'Runtime call');
    case 'head-unpin-request': {
      const record = toRecord(inner);
      const hashes = toArrayValue(record?.['hashes']);
      return `Release ${formatCount(hashes.length, 'pinned block')}${formatFollowSuffix(annotations.followSubscriptionId)}.`;
    }
    case 'head-unpin-response':
      return summariseSimpleResponse(annotations, 'Unpin');
    case 'head-continue-request':
      return `Continue paused storage operation ${abbreviateId(annotations.operationId)}${formatFollowSuffix(annotations.followSubscriptionId)}.`;
    case 'head-continue-response':
      return summariseSimpleResponse(annotations, 'Continue');
    case 'head-stop-op-request':
      return `Abort operation ${abbreviateId(annotations.operationId)}${formatFollowSuffix(annotations.followSubscriptionId)}.`;
    case 'head-stop-op-response':
      return summariseSimpleResponse(annotations, 'Stop operation');
    case 'spec-genesis-hash-request':
      return `Look up genesis hash${formatChainSuffix(annotations.genesisHash)}.`;
    case 'spec-genesis-hash-response':
      return summariseStringResponse({ annotations, inner, label: 'Genesis hash' });
    case 'spec-chain-name-request':
      return `Look up chain name${formatChainSuffix(annotations.genesisHash)}.`;
    case 'spec-chain-name-response':
      return summariseStringResponse({ annotations, inner, label: 'Chain name' });
    case 'spec-properties-request':
      return `Look up chain properties${formatChainSuffix(annotations.genesisHash)}.`;
    case 'spec-properties-response':
      return summariseStringResponse({ annotations, inner, label: 'Properties' });
    case 'tx-broadcast-request': {
      const record = toRecord(inner);
      const transaction = toStringValue(record?.['transaction']);
      const bytes = transaction === undefined ? null : countHexBytes(transaction);
      return `Broadcast transaction${bytes === null ? '' : ` (${String(bytes)} bytes)`}${formatChainSuffix(annotations.genesisHash)}.`;
    }
    case 'tx-broadcast-response':
      return summariseBroadcastResponse(annotations);
    case 'tx-stop-request':
      return `Stop broadcasting transaction ${abbreviateId(annotations.operationId)}${formatChainSuffix(annotations.genesisHash)}.`;
    case 'tx-stop-response':
      return summariseSimpleResponse(annotations, 'Stop broadcast');
  }
}

function summariseFollowEvent(inner: unknown): string | null {
  const followEvent = toEnumValue(inner);
  if (followEvent === undefined) {
    return null;
  }
  const eventValue = toRecord(followEvent.value);
  switch (followEvent.tag) {
    case 'Initialized': {
      const hashes = toArrayValue(eventValue?.['finalizedBlockHashes']);
      return `Initialised with ${formatCount(hashes.length, 'finalized block')}.`;
    }
    case 'NewBlock': {
      const block = toStringValue(eventValue?.['blockHash']);
      const parent = toStringValue(eventValue?.['parentBlockHash']);
      return `New block ${formatBlock(block)} (parent ${formatBlock(parent)}).`;
    }
    case 'BestBlockChanged': {
      const block = toStringValue(eventValue?.['bestBlockHash']);
      return `Best block now ${formatBlock(block)}.`;
    }
    case 'Finalized': {
      const finalized = toArrayValue(eventValue?.['finalizedBlockHashes']);
      const pruned = toArrayValue(eventValue?.['prunedBlockHashes']);
      return `Finalized ${formatCount(finalized.length, 'block')}, pruned ${String(pruned.length)}.`;
    }
    case 'OperationBodyDone': {
      const extrinsics = toArrayValue(eventValue?.['value']);
      return `Body returned: ${formatCount(extrinsics.length, 'extrinsic')}${formatOperationSuffix(eventValue)}.`;
    }
    case 'OperationCallDone':
      return `Runtime call result ready${formatOperationSuffix(eventValue)}.`;
    case 'OperationStorageItems': {
      const items = toArrayValue(eventValue?.['items']);
      return `Storage batch: ${formatCount(items.length, 'item')}${formatOperationSuffix(eventValue)}.`;
    }
    case 'OperationStorageDone':
      return `Storage operation complete${formatOperationSuffix(eventValue)}.`;
    case 'OperationWaitingForContinue':
      return `Paused. Client must call chainHead.continue${formatOperationSuffix(eventValue)}.`;
    case 'OperationInaccessible':
      return `Block unavailable, retry${formatOperationSuffix(eventValue)}.`;
    case 'OperationError': {
      const error = toStringValue(eventValue?.['error']);
      return `Operation failed: ${error ?? 'unknown'}${formatOperationSuffix(eventValue)}.`;
    }
    case 'Stop':
      return 'Subscription stopped by the server. Client must create a new follow.';
  }
  return null;
}

function summariseStorageRequest(annotations: ChainAnnotations, inner: unknown): string {
  const record = toRecord(inner);
  const items = toArrayValue(record?.['items']);
  const types = new Set<string>();
  for (const item of items) {
    const type = toStringValue(toRecord(item)?.['type']);
    if (type !== undefined) {
      types.add(type);
    }
  }
  const typeSuffix = types.size === 0 ? '' : ` (${Array.from(types).join(', ')})`;
  return `Query ${formatCount(items.length, 'storage item')}${typeSuffix} on block ${formatBlock(annotations.blockHash)}${formatFollowSuffix(annotations.followSubscriptionId)}.`;
}

function summariseCallRequest(annotations: ChainAnnotations, inner: unknown): string {
  const record = toRecord(inner);
  const functionName = toStringValue(record?.['function']);
  return `Invoke runtime api ${functionName ?? '?'} on block ${formatBlock(annotations.blockHash)}${formatFollowSuffix(annotations.followSubscriptionId)}.`;
}

function summariseHeaderResponse(annotations: ChainAnnotations, inner: unknown): string | null {
  if (annotations.outcome === 'error') {
    return `Header fetch failed: ${annotations.errorMessage ?? 'unknown'}.`;
  }
  const record = toRecord(inner);
  const value = record?.['value'];
  if (value === null) {
    return 'Block not found (header null).';
  }
  const bytes = countHexBytes(toStringValue(value) ?? '');
  const bytesLabel = bytes === null ? '?' : String(bytes);
  return `Header returned (${bytesLabel} bytes).`;
}

function summariseBroadcastResponse(annotations: ChainAnnotations): string | null {
  if (annotations.outcome === undefined) {
    return null;
  }
  switch (annotations.outcome) {
    case 'started':
      return `Broadcast accepted. Tracking id: ${annotations.operationId ?? '?'}.`;
    case 'limit-reached':
      return 'Broadcast rejected: node at capacity.';
    case 'error':
      return `Broadcast error: ${annotations.errorMessage ?? 'unknown'}.`;
    case 'ok':
      return null;
  }
}

function summariseOperationStarter(annotations: ChainAnnotations, label: string): string | null {
  if (annotations.outcome === undefined) {
    return null;
  }
  switch (annotations.outcome) {
    case 'started':
      return `${label} accepted. Operation id: ${annotations.operationId ?? '?'}. Result will stream through the follow subscription.`;
    case 'limit-reached':
      return `${label} rejected: node at capacity.`;
    case 'error':
      return `${label} rejected: ${annotations.errorMessage ?? 'unknown'}.`;
    case 'ok':
      return null;
  }
}

function summariseSimpleResponse(annotations: ChainAnnotations, label: string): string | null {
  if (annotations.outcome === undefined) {
    return null;
  }
  switch (annotations.outcome) {
    case 'ok':
      return `${label} acknowledged.`;
    case 'error':
      return `${label} failed: ${annotations.errorMessage ?? 'unknown'}.`;
    case 'started':
    case 'limit-reached':
      return null;
  }
}

function summariseStringResponse({ annotations, inner, label }: Params): string | null {
  if (annotations.outcome === 'error') {
    return `${label} lookup failed: ${annotations.errorMessage ?? 'unknown'}.`;
  }
  const record = toRecord(inner);
  const value = toStringValue(record?.['value']);
  if (value === undefined) {
    return `${label} lookup returned.`;
  }
  return `${label}: ${value}.`;
}

function formatBlock(hash: string | undefined): string {
  return hash === undefined ? '?' : formatHexHeadAndTail(hash);
}

function formatChainSuffix(hash: string | undefined): string {
  return hash === undefined ? '' : ` on ${formatChainDisplay(hash)}`;
}

function formatFollowSuffix(subscriptionId: string | undefined): string {
  return subscriptionId === undefined ? '' : ` (sub ${subscriptionId})`;
}

function abbreviateId(id: string | undefined): string {
  if (id === undefined) {
    return '?';
  }
  return formatIdHead(id);
}

function formatOperationSuffix(eventValue: Record<string, unknown> | undefined): string {
  return ` (op ${abbreviateId(toStringValue(eventValue?.['operationId']))})`;
}

function toArrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function countHexBytes(hex: string): number | null {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (body.length % 2 !== 0) {
    return null;
  }
  return body.length / 2;
}
