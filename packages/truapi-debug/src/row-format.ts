// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Pure list-row summary helpers for TrUAPI/system debug events.
//
// Solid-free: consumed by the Solid truapi-debug components in
// `packages/ui/src/components/truapi-debug/`, so it must not import
// `@dotli/ui` or `solid-js`. These functions return plain data, never
// markup — callers that render to `innerHTML` are responsible for
// `escapeHtml`-guarding every field before it reaches the DOM; callers
// that render via JSX get automatic text escaping instead.

import {
  decodeChainAnnotations,
  formatChainLabel,
  type ChainAnnotations,
} from "./chain-decode.js";
import type { StoredSystemEvent, StoredTruapiEvent } from "./event-store.js";
import { formatPayloadSummary } from "./format.js";
import { summariseSystemEvent } from "./system-summary.js";

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
  if (ann.outcome === "error") {
    parts.push(`err: ${ann.errorMessage ?? "?"}`);
  } else if (ann.outcome === "limit-reached") {
    parts.push("limit-reached");
  }
  return parts.join(" · ");
}

/** Trim a 0x-prefixed hash or a long id down to a glance-friendly token. */
export function shortHex(v: string): string {
  if (v.startsWith("0x") && v.length > 12) {
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

export function tagClass(tag: string): string {
  if (
    tag.endsWith("_request") ||
    tag.endsWith("_start") ||
    tag.endsWith("_submit")
  ) {
    return "td-tag td-tag-req";
  }
  if (tag.endsWith("_response")) {
    return "td-tag td-tag-res";
  }
  if (
    tag.endsWith("_receive") ||
    tag.endsWith("_interrupt") ||
    tag.endsWith("_stop") ||
    tag.endsWith("_subscribe")
  ) {
    return "td-tag td-tag-sub";
  }
  return "td-tag";
}

export interface TruapiRowData {
  direction: StoredTruapiEvent["direction"];
  productId: string | undefined;
  requestId: string;
  ridShort: string;
  ridColor: string;
  tagClassName: string;
  displayTag: string;
  summary: string;
  pendingKey: string | null;
}

/**
 * Pure fields derived from a stored TrUAPI event for its list row: the
 * decoded chain label/summary plus the badge inputs. Markup assembly
 * (with `escapeHtml`) is the caller's job.
 */
export function truapiRowData(
  ev: StoredTruapiEvent,
  pendingKey: string | null,
): TruapiRowData {
  const chain = decodeChainAnnotations(ev.tag, ev.payload);
  const displayTag = chain === null ? ev.tag : formatChainLabel(chain);
  const summary =
    chain === null ? formatPayloadSummary(ev.payload) : chainSummary(chain);
  return {
    direction: ev.direction,
    productId: ev.productId,
    requestId: ev.requestId,
    ridShort: ev.requestId.slice(0, 6),
    ridColor: ridColor(ev.requestId),
    tagClassName: tagClass(ev.tag),
    displayTag,
    summary,
    pendingKey,
  };
}

export interface SystemRowData {
  layer: string;
  source: StoredSystemEvent["source"];
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

/**
 * Class attribute of a list row. Order is part of the markup contract:
 * td-row, selected, paired, system.
 */
export function rowClassName(
  selected: boolean,
  paired: boolean,
  system: boolean,
): string {
  let out = "td-row";
  if (selected) {
    out += " selected";
  }
  if (paired) {
    out += " paired";
  }
  if (system) {
    out += " system";
  }
  return out;
}
