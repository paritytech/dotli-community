// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Must not import `@dotli/ui` or `solid-js`. Returns plain data that callers render as JSX text, which escapes it.

import { decodeChainAnnotations, formatChainLabel, type ChainAnnotations } from './chain-decode.js';
import type { StoredSystemEvent, StoredTruapiEvent } from './event-store.js';
import { formatPayloadSummary } from './format.js';
import { summariseSystemEvent } from './system-summary.js';

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

export function shortHex(v: string): string {
  if (v.startsWith('0x') && v.length > 12) {
    return `${v.slice(0, 8)}…${v.slice(-4)}`;
  }
  if (v.length > 10) {
    return `${v.slice(0, 8)}…`;
  }
  return v;
}

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
  tagKind: TagKind;
  displayTag: string;
  summary: string;
  pendingKey: string | null;
}

export function truapiRowData(ev: StoredTruapiEvent, pendingKey: string | null): TruapiRowData {
  const chain = decodeChainAnnotations(ev.tag, ev.payload);
  const displayTag = chain === null ? ev.tag : formatChainLabel(chain);
  const summary = chain === null ? formatPayloadSummary(ev.payload) : chainSummary(chain);
  return {
    direction: ev.direction,
    productId: ev.productId,
    requestId: ev.requestId,
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
  eventText: string;
  summary: string;
}

export function systemRowData(ev: StoredSystemEvent): SystemRowData {
  return {
    layer: ev.layer,
    source: ev.source,
    flowId: ev.flowId,
    eventText: `${ev.layer}.${ev.event}`,
    summary: summariseSystemEvent(ev),
  };
}

export type RowSelection = 'selected' | 'paired';

export function rowSelection(selected: boolean, inSelectedGroup: boolean): RowSelection | undefined {
  if (selected) {
    return 'selected';
  }
  return inSelectedGroup ? 'paired' : undefined;
}
