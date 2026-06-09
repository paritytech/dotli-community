// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// TrUAPI timeline SVG renderer
//
// Keyed reconciliation renderer: each logical entity (rail, segment,
// tick, persistent decoration) is keyed on a stable id, and on every
// render we walk the new layout and update existing SVG nodes in
// place. Stale nodes are removed, genuinely-new nodes are created.
//
// The rebuild-from-scratch pattern (setting `svg.innerHTML = ...`)
// destroys every DOM node, losing hover state and cursor tracking on
// every tick of incoming traffic, which the user saw as "boxes flash
// when a new event arrives". Reconciliation keeps the underlying
// element identity stable so the browser's native hover/selection
// tracking is uninterrupted.

import type { EventSeq, StoredEvent } from "./event-store.ts";
import {
  computeGlobalYPositions,
  computeLayout,
  LANE_GAP,
  LANE_GUTTER,
  LANE_WIDTH,
  MARGIN_WIDTH,
  partitionIntoSwimlanes,
  RAIL_COL_WIDTH,
  ROW_HEIGHT,
  type Layout,
  type LayoutOptions,
  type RailEntry,
  type SegmentEntry,
  type SwimlanePartition,
  type TickEntry,
} from "./timeline-layout.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Keyed element cache scoped to a specific SVG root. */
type ElementCache = Map<string, Element>;
const cacheBySvg = new WeakMap<SVGSVGElement, ElementCache>();

export function buildTimelineContainer(): { container: HTMLDivElement } {
  const container = document.createElement("div");
  container.className = "td-timeline";
  container.tabIndex = 0;
  // Inner flex-row that holds the swimlane columns. Managed by
  // renderSwimlanes via keyed reconciliation.
  const row = document.createElement("div");
  row.className = "td-sw-row";
  container.appendChild(row);
  return { container };
}

/**
 * Render the full timeline into a pre-built container. Partitions the
 * events into swimlanes (one per chain genesisHash plus `Other`), then
 * ensures a dedicated SVG per swimlane and renders each with a shared
 * global Y axis so the same vertical position across swimlanes
 * corresponds to the same moment in time.
 */
export function renderSwimlanes(
  container: HTMLDivElement,
  events: readonly StoredEvent[],
  selectedSeq: EventSeq | null,
): void {
  const row = container.querySelector<HTMLDivElement>(".td-sw-row");
  if (row === null) {
    return;
  }

  const layoutOpts = computeGlobalYPositions(events);
  const swimlanes = partitionIntoSwimlanes(events);

  // Keyed reconcile swimlane columns.
  const existingCols = new Map<string, HTMLElement>();
  for (const child of Array.from(row.children)) {
    const key = child.getAttribute("data-sw-key");
    if (key !== null) {
      existingCols.set(key, child as HTMLElement);
    }
  }

  // Keep user-facing order stable by re-inserting columns in swimlane order.
  const touched = new Set<string>();
  for (const sw of swimlanes) {
    touched.add(sw.key);
    let col = existingCols.get(sw.key);
    if (col === undefined) {
      col = createSwimlaneColumn(sw);
      row.appendChild(col);
    } else {
      // Update header attributes if the accent color changed (shouldn't
      // happen for stable keys but harmless to re-apply).
      const head = col.querySelector<HTMLElement>(".td-sw-header");
      head?.style.setProperty("--sw-accent", sw.color);
      const label = col.querySelector<HTMLElement>(".td-sw-header-label");
      if (label !== null && label.textContent !== sw.header) {
        label.textContent = sw.header;
      }
      row.appendChild(col); // re-append to preserve insertion order
    }
    const svg = col.querySelector<SVGSVGElement>("svg.td-tl-svg");
    if (svg !== null) {
      renderTimeline(svg, sw.events, selectedSeq, layoutOpts);
    }
  }
  // Remove stale columns.
  for (const [key, el] of existingCols) {
    if (!touched.has(key)) {
      el.remove();
    }
  }
}

function createSwimlaneColumn(sw: SwimlanePartition): HTMLElement {
  const col = document.createElement("div");
  col.className = "td-sw-col";
  col.setAttribute("data-sw-key", sw.key);

  const header = document.createElement("div");
  header.className = "td-sw-header";
  header.style.setProperty("--sw-accent", sw.color);
  const label = document.createElement("span");
  label.className = "td-sw-header-label";
  label.textContent = sw.header;
  header.appendChild(label);
  col.appendChild(header);

  const body = document.createElement("div");
  body.className = "td-sw-body";
  col.appendChild(body);

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "td-tl-svg");
  svg.setAttribute("xmlns", SVG_NS);
  body.appendChild(svg);

  return col;
}

function renderTimeline(
  svg: SVGSVGElement,
  events: readonly StoredEvent[],
  selectedSeq: EventSeq | null,
  layoutOpts: LayoutOptions,
): Layout {
  const layout = computeLayout(events, layoutOpts);

  const railsEndX = MARGIN_WIDTH + layout.railCount * RAIL_COL_WIDTH;
  const lanesStartX = railsEndX + LANE_GUTTER;
  const totalWidth =
    lanesStartX + layout.laneCount * (LANE_WIDTH + LANE_GAP) + LANE_GAP;
  const totalHeight = Math.max(ROW_HEIGHT, layout.totalHeight);

  svg.setAttribute("width", String(totalWidth));
  svg.setAttribute("height", String(totalHeight));
  svg.setAttribute(
    "viewBox",
    `0 0 ${String(totalWidth)} ${String(totalHeight)}`,
  );

  const cache = getCache(svg);
  const touched = new Set<string>();

  // Persistent decorations (dividers). Always present. Reusing them
  // across renders keeps them stable even under constant layout churn.
  upsertLine(
    svg,
    cache,
    touched,
    "div-margin",
    "td-tl-divider",
    MARGIN_WIDTH,
    0,
    MARGIN_WIDTH,
    totalHeight,
  );
  if (layout.railCount > 0) {
    upsertLine(
      svg,
      cache,
      touched,
      "div-rails",
      "td-tl-divider",
      railsEndX,
      0,
      railsEndX,
      totalHeight,
    );
  }

  for (const entry of layout.entries) {
    if (entry.kind === "rail") {
      upsertRail(svg, cache, touched, entry);
    } else if (entry.kind === "tick") {
      upsertTick(svg, cache, touched, entry);
    } else {
      upsertSegment(svg, cache, touched, entry, lanesStartX, selectedSeq);
    }
  }

  // Sweep: anything the layout no longer includes gets removed.
  for (const [key, el] of cache) {
    if (!touched.has(key)) {
      el.remove();
      cache.delete(key);
    }
  }

  return layout;
}

function getCache(svg: SVGSVGElement): ElementCache {
  let c = cacheBySvg.get(svg);
  if (c === undefined) {
    c = new Map();
    cacheBySvg.set(svg, c);
    // Adopt any pre-existing keyed children (shouldn't happen in
    // practice, but keeps the cache authoritative).
    for (const child of Array.from(svg.children)) {
      const k = child.getAttribute("data-key");
      if (k !== null) {
        c.set(k, child);
      }
    }
  }
  return c;
}

function acquire<K extends keyof SVGElementTagNameMap>(
  svg: SVGSVGElement,
  cache: ElementCache,
  key: string,
  tag: K,
  cssClass: string,
): SVGElementTagNameMap[K] {
  let el = cache.get(key);
  if (el?.tagName !== tag) {
    el?.remove();
    el = document.createElementNS(SVG_NS, tag);
    el.setAttribute("data-key", key);
    el.setAttribute("class", cssClass);
    svg.appendChild(el);
    cache.set(key, el);
  }
  return el as SVGElementTagNameMap[K];
}

function setAttr(el: Element, name: string, value: string): void {
  // setAttribute triggers a DOM mutation even when the value is
  // unchanged; skip the write for no-op cases to keep hover-target
  // bookkeeping stable under rapid re-renders.
  if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}

function removeAttr(el: Element, name: string): void {
  if (el.hasAttribute(name)) {
    el.removeAttribute(name);
  }
}

function upsertLine(
  svg: SVGSVGElement,
  cache: ElementCache,
  touched: Set<string>,
  key: string,
  cssClass: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): SVGLineElement {
  const el = acquire(svg, cache, key, "line", cssClass);
  setAttr(el, "x1", String(x1));
  setAttr(el, "y1", String(y1));
  setAttr(el, "x2", String(x2));
  setAttr(el, "y2", String(y2));
  touched.add(key);
  return el;
}

function upsertRail(
  svg: SVGSVGElement,
  cache: ElementCache,
  touched: Set<string>,
  rail: RailEntry,
): void {
  const x = MARGIN_WIDTH + rail.railIdx * RAIL_COL_WIDTH + RAIL_COL_WIDTH / 2;

  const lineKey = `rail-${String(rail.seqAnchor)}`;
  const line = upsertLine(
    svg,
    cache,
    touched,
    lineKey,
    "td-tl-rail",
    x,
    rail.topY + 2,
    x,
    rail.bottomY - 2,
  );
  setAttr(line, "stroke", rail.color);
  setAttr(line, "data-seq", String(rail.seqAnchor));
  setAttr(line, "data-kind", "rail");
  if (rail.pending) {
    setAttr(line, "stroke-dasharray", "2 3");
  } else {
    removeAttr(line, "stroke-dasharray");
  }

  setAttr(
    line,
    "data-tooltip",
    `follow · ${rail.label}${rail.pending ? " (pending)" : ""}`,
  );
}

function upsertTick(
  svg: SVGSVGElement,
  cache: ElementCache,
  touched: Set<string>,
  tick: TickEntry,
): void {
  const key = `tick-${String(tick.seq)}`;
  const circle = acquire(svg, cache, key, "circle", "td-tl-tick");
  touched.add(key);
  setAttr(circle, "cx", String(MARGIN_WIDTH / 2));
  setAttr(circle, "cy", String(tick.y));
  setAttr(circle, "r", "2");
  setAttr(circle, "fill", tick.color);
  setAttr(circle, "data-seq", String(tick.seq));
  setAttr(circle, "data-kind", "tick");
  setAttr(circle, "data-tooltip", tick.variant);
}

function upsertSegment(
  svg: SVGSVGElement,
  cache: ElementCache,
  touched: Set<string>,
  seg: SegmentEntry,
  lanesStartX: number,
  selectedSeq: EventSeq | null,
): void {
  const x = lanesStartX + seg.lane * (LANE_WIDTH + LANE_GAP);
  const y = seg.topY + 1;
  const h = Math.max(ROW_HEIGHT - 2, seg.bottomY - seg.topY - 2);
  const isSelected =
    selectedSeq !== null && seg.memberSeqs.includes(selectedSeq);

  // Rect (hover target, kept stable across re-renders). No inline
  // text: labels went into the hover tooltip so boxes can stay very
  // narrow without overflow, and the detail pane carries the rest.
  const rectKey = `seg-${String(seg.seqAnchor)}`;
  const rect = acquire(svg, cache, rectKey, "rect", "td-tl-segment");
  touched.add(rectKey);
  setAttr(rect, "x", String(x));
  setAttr(rect, "y", String(y));
  setAttr(rect, "width", String(LANE_WIDTH));
  setAttr(rect, "height", String(h));
  setAttr(rect, "rx", "2");
  setAttr(rect, "ry", "2");
  setAttr(rect, "fill", seg.color);
  setAttr(rect, "data-seq", String(seg.seqAnchor));
  setAttr(rect, "data-seqs", seg.memberSeqs.map((s) => String(s)).join(","));
  setAttr(rect, "data-kind", "segment");
  setAttr(rect, "data-tooltip", buildSegmentTooltip(seg));
  const cls = ["td-tl-segment"];
  if (seg.pending) {
    cls.push("pending");
  }
  if (isSelected) {
    cls.push("selected");
  }
  setAttr(rect, "class", cls.join(" "));
  if (isSelected) {
    setAttr(rect, "stroke", "#fff");
    setAttr(rect, "stroke-width", "2");
  } else {
    removeAttr(rect, "stroke");
    removeAttr(rect, "stroke-width");
  }

  // Optional connector to the linked rail.
  const connectorKey = `seg-conn-${String(seg.seqAnchor)}`;
  if (seg.linkedRailIdx !== undefined) {
    const railCenterX =
      MARGIN_WIDTH + seg.linkedRailIdx * RAIL_COL_WIDTH + RAIL_COL_WIDTH / 2;
    const connectorY = y + h / 2;
    const line = upsertLine(
      svg,
      cache,
      touched,
      connectorKey,
      "td-tl-connector",
      railCenterX + RAIL_COL_WIDTH / 2,
      connectorY,
      x,
      connectorY,
    );
    setAttr(line, "stroke", seg.color);
  }
  // Pending-edge dashed line at the box bottom.
  const pendingKey = `seg-pending-${String(seg.seqAnchor)}`;
  if (seg.pending) {
    upsertLine(
      svg,
      cache,
      touched,
      pendingKey,
      "td-tl-pending-edge",
      x + 1,
      y + h,
      x + LANE_WIDTH - 1,
      y + h,
    );
  }
}

/**
 * Compose the tooltip string for a segment: method name, detail, and
 * a pending marker so the user can distinguish "in-flight" from
 * "complete" boxes at a glance.
 */
function buildSegmentTooltip(seg: SegmentEntry): string {
  const parts = [seg.label];
  if (seg.detail !== undefined) {
    parts.push(seg.detail);
  }
  if (seg.pending) {
    parts.push("(pending)");
  }
  return parts.join(" · ");
}

/**
 * Flip the `selected` class and highlight stroke between two segments
 * without recomputing anything else. Called from panel.ts on click.
 * Searches across every swimlane's SVG within the container.
 */
export function applyTimelineSelection(
  container: HTMLDivElement,
  prevSeq: EventSeq | null,
  newSeq: EventSeq | null,
): void {
  if (prevSeq !== null) {
    const prev = findSegmentForSeq(container, prevSeq);
    if (prev !== null) {
      prev.classList.remove("selected");
      prev.removeAttribute("stroke");
      prev.removeAttribute("stroke-width");
    }
  }
  if (newSeq !== null) {
    const next = findSegmentForSeq(container, newSeq);
    if (next !== null) {
      next.classList.add("selected");
      next.setAttribute("stroke", "#fff");
      next.setAttribute("stroke-width", "2");
      next.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }
}

function findSegmentForSeq(
  container: HTMLDivElement,
  seq: EventSeq,
): SVGRectElement | null {
  const segs = container.querySelectorAll<SVGRectElement>(".td-tl-segment");
  for (const seg of Array.from(segs)) {
    const seqs = seg.dataset.seqs?.split(",") ?? [];
    if (seqs.includes(String(seq))) {
      return seg;
    }
  }
  return null;
}

export function resolveTimelineClick(
  target: EventTarget | null,
): EventSeq | null {
  if (target === null) {
    return null;
  }
  const el = target as Element;
  const hit = el.closest("[data-seq]");
  if (hit === null) {
    return null;
  }
  const seqAttr = hit.getAttribute("data-seq");
  if (seqAttr === null) {
    return null;
  }
  const n = Number(seqAttr);
  return Number.isFinite(n) ? n : null;
}
