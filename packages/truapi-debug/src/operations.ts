// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Live-operations model for the debug banner.
//
// Folds the flat dotli system-event stream into one row per flow, mirroring
// the iOS stall banner (`StallBoard` feeding `StallBannerView`): a row is an
// operation the host is performing, and each event inside that flow is a step
// with a done / running / failed state.
//
// Grouping is by `flowId` *and* `layer`, not `flowId` alone: the host mints a
// single per-tab flow id that boot, resolve, render and bridge all carry, so
// keying on the flow id alone would collapse the whole page load into one row.
//
// Pure. The banner passes the store's buffer in and renders what comes back.

import { withActiveTld } from "@dotli/config/network";
import type { StoredEvent, StoredSystemEvent } from "./event-store.ts";
import { asObj } from "./shape.ts";

/** Rows shown before the rest fold into the "+N more" line. Matches
 *  `StallBannerViewModelFactory.defaultMaxVisibleRows`. */
export const DEFAULT_MAX_VISIBLE = 3;

export type StepState = "done" | "current" | "failed";

export interface OperationStep {
  seq: number;
  title: string;
  state: StepState;
  detail: string | null;
}

export interface Operation {
  /** `${flowId}::${layer}`. Stable for the lifetime of the flow. */
  id: string;
  layer: string;
  /** Subject of the operation: the dot name, CID, or product it acts on. */
  title: string;
  steps: OperationStep[];
  done: boolean;
}

export interface OperationsSnapshot {
  operations: Operation[];
  /** Operations trimmed off the end by `maxVisible`. */
  hiddenCount: number;
}

export interface BuildOptions {
  dismissed?: ReadonlySet<string>;
  maxVisible?: number;
}

/** Events that close their flow. Once one lands, the flow stops showing a
 *  running step and every step reads as settled. */
const TERMINAL_EVENTS = new Set([
  "boot:ready",
  "boot:failed",
  "boot:landing_page_shown",
  "resolve:completed",
  "resolve:failed",
  "render:iframe_ready",
  "bridge:first_outbound",
  "failover:chain_backend",
  "sandbox:document_written",
  "sandbox:failed",
]);

/** The main-thread monitor emits a heartbeat every 2s and never settles.
 *  It belongs in the panel's system swimlane, not in a banner about what
 *  the host is working on. */
const EXCLUDED_LAYERS = new Set(["main"]);

export function buildOperations(
  events: readonly StoredEvent[],
  options: BuildOptions = {},
): OperationsSnapshot {
  const dismissed = options.dismissed ?? new Set<string>();
  const maxVisible = options.maxVisible ?? DEFAULT_MAX_VISIBLE;

  // Insertion order is arrival order, so the map already holds the flows
  // oldest-first, the same ordering the iOS board publishes.
  const groups = new Map<string, StoredSystemEvent[]>();
  for (const ev of events) {
    if (ev.kind !== "system" || EXCLUDED_LAYERS.has(ev.layer)) {
      continue;
    }
    const id = `${ev.flowId}::${ev.layer}`;
    if (dismissed.has(id)) {
      continue;
    }
    const bucket = groups.get(id);
    if (bucket === undefined) {
      groups.set(id, [ev]);
    } else {
      bucket.push(ev);
    }
  }

  const all: Operation[] = [];
  for (const [id, group] of groups) {
    all.push(toOperation(id, group));
  }

  return {
    operations: all.slice(0, maxVisible),
    hiddenCount: Math.max(0, all.length - maxVisible),
  };
}

function toOperation(id: string, group: StoredSystemEvent[]): Operation {
  const done = group.some((ev) =>
    TERMINAL_EVENTS.has(`${ev.layer}:${ev.event}`),
  );
  const lastSeq = group[group.length - 1].seq;

  const steps = group.map((ev) => ({
    seq: ev.seq,
    title: stepTitle(ev),
    state: stepState(ev, { done, lastSeq }),
    detail: stepDetail(ev),
  }));

  return {
    id,
    layer: group[0].layer,
    title: operationTitle(group),
    steps,
    done,
  };
}

function stepState(
  ev: StoredSystemEvent,
  flow: { done: boolean; lastSeq: number },
): StepState {
  if (ev.event === "failed") {
    return "failed";
  }
  // Events are points, not spans, so the newest event of an open flow stands
  // in for "this is what is happening right now".
  if (!flow.done && ev.seq === flow.lastSeq) {
    return "current";
  }
  return "done";
}

/** `resolve:phase` and `sandbox:status` carry the wording the layer already
 *  shows its own users; everything else reads fine as the event name. */
function stepTitle(ev: StoredSystemEvent): string {
  const payload = asObj(ev.payload);
  const message = payload?.message;
  if (typeof message === "string" && message !== "") {
    return message;
  }
  return ev.event.replace(/_/g, " ");
}

function stepDetail(ev: StoredSystemEvent): string | null {
  const payload = asObj(ev.payload);
  if (payload === undefined) {
    return null;
  }
  if (typeof payload.reason === "string" && payload.reason !== "") {
    return payload.reason;
  }
  return null;
}

/** First identifying value anywhere in the flow. `boot:started` has none, so
 *  the title only settles once `boot:url_parsed` names a label. */
function operationTitle(group: StoredSystemEvent[]): string {
  for (const ev of group) {
    const payload = asObj(ev.payload);
    if (payload === undefined) {
      continue;
    }
    if (typeof payload.label === "string" && payload.label !== "") {
      return withActiveTld(payload.label);
    }
    if (typeof payload.cid === "string" && payload.cid !== "") {
      return shortenCid(payload.cid);
    }
    if (typeof payload.productId === "string" && payload.productId !== "") {
      return payload.productId;
    }
  }
  return group[0].layer;
}

function shortenCid(cid: string): string {
  if (cid.length <= 16) {
    return cid;
  }
  return `${cid.slice(0, 8)}…${cid.slice(-4)}`;
}
