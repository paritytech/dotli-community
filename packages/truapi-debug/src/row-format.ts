// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Pure list-row summary helpers for TrUAPI/system debug events.
//
// Solid-free: consumed by the Solid truapi-debug components in
// `packages/ui/src/components/truapi-debug/`, so it must not import
// `@dotli/ui` or `solid-js`. These functions return plain data, never
// markup. The callers render every field as JSX text, which escapes it.

import { decodeChainAnnotations, formatChainLabel, type ChainAnnotations } from './chain-decode.js';
import type { StoredSystemEvent, StoredTruapiEvent } from './event-store.js';
import { formatPayloadSummary } from './format.js';
import { summariseSystemEvent } from './system-summary.js';

/**
 * Compact summary rendered in the list row for a decoded chain message.
 * Prioritises the correlation keys that distinguish similar rows:
 * block hash for head operations, operationId for started/received ops,
 * outcome for responses, error message for failures.
 */
export function chainSummary(ann: ChainAnnotations): string {
  const parts: string[] = [];
  if (ann.chainEventTag !== undefined && ann.operationId !== undefined) {
    parts.push(`op ${shortHex(ann.operationId)}`);
  } else if (ann.operationId !== undefined) {
    parts.push(`op ${shortHex(ann.operationId)}`);
  }
  if (ann.blockHash !== undefined) {
    parts.push(`blk ${shortHex(ann.blockHash)}`);
  }
  if (ann.outcome === 'error') {
    parts.push(`err: ${ann.errorMessage ?? '?'}`);
  } else if (ann.outcome === 'limit-reached') {
    parts.push('limit-reached');
  }
  return parts.join(' · ');
}

/** Trim a 0x-prefixed hash or a long id down to a glance-friendly token. */
export function shortHex(v: string): string {
  if (v.startsWith('0x') && v.length > 12) {
    return `${v.slice(0, 8)}…${v.slice(-4)}`;
  }
  if (v.length > 10) {
    return `${v.slice(0, 8)}…`;
  }
  return v;
}

/** Deterministic hue for a requestId. The same id yields the same color on every row. */
export function ridColor(rid: string): string {
  let h = 0;
  for (let i = 0; i < rid.length; i++) {
    h = (h * 31 + rid.charCodeAt(i)) | 0;
  }
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${String(hue)}, 65%, 65%)`;
}

export type TagKind = 'request' | 'response' | 'subscription' | 'plain';

export function tagKind(tag: string): TagKind {
  if (tag.endsWith('_request') || tag.endsWith('_start') || tag.endsWith('_submit')) {
    return 'request';
  }
  if (tag.endsWith('_response')) {
    return 'response';
  }
  if (tag.endsWith('_receive') || tag.endsWith('_interrupt') || tag.endsWith('_stop') || tag.endsWith('_subscribe')) {
    return 'subscription';
  }
  return 'plain';
}

export interface TruapiRowData {
  direction: StoredTruapiEvent['direction'];
  productId: string | undefined;
  requestId: string;
  ridShort: string;
  ridColor: string;
  tagKind: TagKind;
  displayTag: string;
  summary: string;
  pendingKey: string | null;
}

/**
 * Pure fields derived from a stored TrUAPI event for its list row: the
 * decoded chain label/summary plus the badge inputs.
 */
export function truapiRowData(ev: StoredTruapiEvent, pendingKey: string | null): TruapiRowData {
  const chain = decodeChainAnnotations(ev.tag, ev.payload);
  const displayTag = chain === null ? ev.tag : formatChainLabel(chain);
  const summary = chain === null ? formatPayloadSummary(ev.payload) : chainSummary(chain);
  return {
    direction: ev.direction,
    productId: ev.productId,
    requestId: ev.requestId,
    ridShort: ev.requestId.slice(0, 6),
    ridColor: ridColor(ev.requestId),
    tagKind: tagKind(ev.tag),
    displayTag,
    summary,
    pendingKey,
  };
}

export interface SystemRowData {
  layer: string;
  source: StoredSystemEvent['source'];
  flowId: string;
  flowIdShort: string;
  ridColor: string;
  eventText: string;
  summary: string;
}

/** Pure fields derived from a stored system event for its list row. */
export function systemRowData(ev: StoredSystemEvent): SystemRowData {
  return {
    layer: ev.layer,
    source: ev.source,
    flowId: ev.flowId,
    flowIdShort: ev.flowId.slice(0, 6),
    ridColor: ridColor(ev.flowId),
    eventText: `${ev.layer}.${ev.event}`,
    summary: summariseSystemEvent(ev),
  };
}

export type RowSelection = 'selected' | 'paired';

/**
 * A row is `selected` when it is the selected event, and `paired` when it
 * shares the selected event's correlation key. A selected row is never also
 * paired.
 */
export function rowSelection(selected: boolean, inSelectedGroup: boolean): RowSelection | undefined {
  if (selected) {
    return 'selected';
  }
  return inSelectedGroup ? 'paired' : undefined;
}
