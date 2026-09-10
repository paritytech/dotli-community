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
// A flow only surfaces once it has been open for `revealAfterMs`, so a page
// load that goes to plan stays silent and the banner is only ever about work
// that is taking longer than it should. Same idea as `StallBoard.revealAfter`,
// including the part where a flow that settles under the threshold is never
// shown at all.
//
// Pure. The banner passes the store's buffer in and renders what comes back.

import { withActiveTld } from "@dotli/config/network";
import type { StoredEvent, StoredSystemEvent } from "./event-store.ts";
import { asObj } from "./shape.ts";

/** Rows shown before the rest fold into the "+N more" line. Matches
 *  `StallBannerViewModelFactory.defaultMaxVisibleRows`. */
export const DEFAULT_MAX_VISIBLE = 3;

/** How long a flow has to stay open before it is worth showing. */
export const DEFAULT_REVEAL_AFTER_MS = 3000;

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
  /** Open flows still under the reveal threshold. While this is non-zero the
   *  banner has to keep re-evaluating on a timer, because crossing the
   *  threshold is the passage of time rather than a new event. */
  pending: number;
}

export interface BuildOptions {
  dismissed?: ReadonlySet<string>;
  maxVisible?: number;
  /** Clock reading to measure flow age against. */
  now?: number;
  revealAfterMs?: number;
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
  const now = options.now ?? 0;
  const revealAfterMs = options.revealAfterMs ?? DEFAULT_REVEAL_AFTER_MS;

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

  const revealed: Operation[] = [];
  let pending = 0;
  for (const [id, group] of groups) {
    const operation = toOperation(id, group);
    // Measure an open flow against the clock and a settled one against the
    // moment it settled, so a flow that finished quickly stays hidden for
    // good instead of ageing into view.
    const reference = endedAt(group) ?? now;
    if (reference - group[0].receivedAt >= revealAfterMs) {
      revealed.push(operation);
    } else if (!operation.done) {
      pending++;
    }
  }

  return {
    operations: revealed.slice(0, maxVisible),
    hiddenCount: Math.max(0, revealed.length - maxVisible),
    pending,
  };
}

function endedAt(group: StoredSystemEvent[]): number | null {
  for (const ev of group) {
    if (TERMINAL_EVENTS.has(`${ev.layer}:${ev.event}`)) {
      return ev.receivedAt;
    }
  }
  return null;
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
