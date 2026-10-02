// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// TrUAPI timeline geometry
//
// Turns the visible events into what the Timeline view draws: one swimlane
// per followed chain plus System and Other, each with its SVG size, its
// dividers, and the rails, ticks and boxes placed in pixels with their
// colours and tooltip strings. Pure: no DOM, no SVG. The layout itself
// (grouping, lane packing, the shared Y axis) is `timeline-layout.ts`.
//
// Every rail, tick and box carries a `key` from its stable seq, so the view
// can key its nodes on it and update a box in place as traffic streams in.

import type { EventSeq, StoredEvent } from './event-store.js';
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
  type SegmentEntry,
} from './timeline-layout.js';

/** A follow-subscription rail: a vertical line in its rail column. */
export interface TimelineRail {
  key: EventSeq;
  seq: EventSeq;
  x: number;
  y1: number;
  y2: number;
  color: string;
  /** Still open: drawn dashed. */
  pending: boolean;
  tooltip: string;
}

/** A zero-duration chain-lifecycle event: a dot in the left margin. */
export interface TimelineTick {
  key: EventSeq;
  seq: EventSeq;
  cx: number;
  cy: number;
  color: string;
  tooltip: string;
}

/** A request/response box, with its optional rail connector and pending edge. */
export interface TimelineBox {
  key: EventSeq;
  seq: EventSeq;
  /** Every event the box stands for. Selecting any of them selects the box. */
  memberSeqs: readonly EventSeq[];
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  pending: boolean;
  tooltip: string;
  /** The dashed line from the linked rail to the box, if it has one. */
  connector: { x1: number; x2: number; y: number } | null;
  /** The dashed line along the bottom of a box still waiting for its end. */
  pendingEdge: { x1: number; x2: number; y: number } | null;
}

export interface TimelineLane {
  /** Stable key: `chain-<genesisHash>`, `system` or `other`. */
  key: string;
  header: string;
  /** The header's accent. */
  color: string;
  width: number;
  height: number;
  /** X of the divider after the tick margin. */
  marginX: number;
  /** X of the divider after the rail columns, when the lane has rails. */
  railsEndX: number | null;
  rails: TimelineRail[];
  ticks: TimelineTick[];
  boxes: TimelineBox[];
}

/**
 * Lay the visible events out as swimlanes. Every lane shares one Y axis, so
 * the same height across lanes is the same moment in time.
 */
export function buildTimeline(events: readonly StoredEvent[]): TimelineLane[] {
  const layoutOpts = computeGlobalYPositions(events);
  return partitionIntoSwimlanes(events).map(sw => {
    const layout = computeLayout(sw.events, layoutOpts);
    const railsEndX = MARGIN_WIDTH + layout.railCount * RAIL_COL_WIDTH;
    const lanesStartX = railsEndX + LANE_GUTTER;
    const lane: TimelineLane = {
      key: sw.key,
      header: sw.header,
      color: sw.color,
      width: lanesStartX + layout.laneCount * (LANE_WIDTH + LANE_GAP) + LANE_GAP,
      height: Math.max(ROW_HEIGHT, layout.totalHeight),
      marginX: MARGIN_WIDTH,
      railsEndX: layout.railCount > 0 ? railsEndX : null,
      rails: [],
      ticks: [],
      boxes: [],
    };
    for (const entry of layout.entries) {
      if (entry.kind === 'rail') {
        const x = MARGIN_WIDTH + entry.railIdx * RAIL_COL_WIDTH + RAIL_COL_WIDTH / 2;
        lane.rails.push({
          key: entry.seqAnchor,
          seq: entry.seqAnchor,
          x,
          y1: entry.topY + 2,
          y2: entry.bottomY - 2,
          color: entry.color,
          pending: entry.pending,
          tooltip: `follow · ${entry.label}${entry.pending ? ' (pending)' : ''}`,
        });
      } else if (entry.kind === 'tick') {
        lane.ticks.push({
          key: entry.seq,
          seq: entry.seq,
          cx: MARGIN_WIDTH / 2,
          cy: entry.y,
          color: entry.color,
          tooltip: entry.variant,
        });
      } else {
        lane.boxes.push(boxOf(entry, lanesStartX));
      }
    }
    return lane;
  });
}

function boxOf(seg: SegmentEntry, lanesStartX: number): TimelineBox {
  const x = lanesStartX + seg.lane * (LANE_WIDTH + LANE_GAP);
  const y = seg.topY + 1;
  const height = Math.max(ROW_HEIGHT - 2, seg.bottomY - seg.topY - 2);
  let connector: TimelineBox['connector'] = null;
  if (seg.linkedRailIdx !== undefined) {
    const railCenterX = MARGIN_WIDTH + seg.linkedRailIdx * RAIL_COL_WIDTH + RAIL_COL_WIDTH / 2;
    connector = { x1: railCenterX + RAIL_COL_WIDTH / 2, x2: x, y: y + height / 2 };
  }
  return {
    key: seg.seqAnchor,
    seq: seg.seqAnchor,
    memberSeqs: seg.memberSeqs,
    x,
    y,
    width: LANE_WIDTH,
    height,
    color: seg.color,
    pending: seg.pending,
    tooltip: segmentTooltip(seg),
    connector,
    pendingEdge: seg.pending ? { x1: x + 1, x2: x + LANE_WIDTH - 1, y: y + height } : null,
  };
}

/**
 * The tooltip for a box: method name, detail, and a pending marker so an
 * in-flight box reads differently from a complete one.
 */
function segmentTooltip(seg: SegmentEntry): string {
  const parts = [seg.label];
  if (seg.detail !== undefined) {
    parts.push(seg.detail);
  }
  if (seg.pending) {
    parts.push('(pending)');
  }
  return parts.join(' · ');
}
