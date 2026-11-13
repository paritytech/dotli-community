// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Every rail, tick and box is keyed by its stable seq, so the view updates a box in place as traffic streams in.

import type { EventSeq, StoredEvent } from './storedEvent.js';
import { computeGlobalYPositions } from './computeGlobalYPositions.js';
import { computeLayout, type SegmentEntry } from './computeLayout.js';
import { LANE_GAP, LANE_GUTTER, LANE_WIDTH, MARGIN_WIDTH, RAIL_COLUMN_WIDTH, ROW_HEIGHT } from './timelineGeometry.js';
import { partitionIntoSwimlanes } from './partitionIntoSwimlanes.js';

export type TimelineRail = {
  seq: EventSeq;
  x: number;
  y1: number;
  y2: number;
  color: string;
  pending: boolean;
  tooltip: string;
};

export type TimelineTick = {
  seq: EventSeq;
  cy: number;
  color: string;
  tooltip: string;
};

export type TimelineBox = {
  seq: EventSeq;
  /** Selecting any of them selects the box. */
  memberSeqs: readonly EventSeq[];
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  pending: boolean;
  tooltip: string;
  connector: { x1: number; x2: number; y: number } | null;
  pendingEdge: { x1: number; x2: number; y: number } | null;
};

export type TimelineLane = {
  key: string;
  header: string;
  color: string;
  width: number;
  height: number;
  railsEndX: number | null;
  rails: TimelineRail[];
  ticks: TimelineTick[];
  boxes: TimelineBox[];
};

/** Every lane shares one Y axis, so the same height across lanes is the same moment. */
export function buildTimeline(events: readonly StoredEvent[]): TimelineLane[] {
  const positions = computeGlobalYPositions(events);
  return partitionIntoSwimlanes(events).map(swimlane => {
    const layout = computeLayout(swimlane.events, positions);
    const railsEndX = MARGIN_WIDTH + layout.rails.length * RAIL_COLUMN_WIDTH;
    const lanesStartX = railsEndX + LANE_GUTTER;
    return {
      key: swimlane.key,
      header: swimlane.header,
      color: swimlane.color,
      width: lanesStartX + layout.laneCount * (LANE_WIDTH + LANE_GAP) + LANE_GAP,
      height: positions.totalHeight,
      railsEndX: layout.rails.length > 0 ? railsEndX : null,
      rails: layout.rails.map(rail => ({
        seq: rail.seqAnchor,
        x: getRailCenterX(rail.railIndex),
        y1: rail.topY + 2,
        y2: rail.bottomY - 2,
        color: rail.color,
        pending: rail.pending,
        tooltip: `follow · ${rail.label}${rail.pending ? ' (pending)' : ''}`,
      })),
      ticks: layout.ticks.map(tick => ({ seq: tick.seq, cy: tick.y, color: tick.color, tooltip: tick.variant })),
      boxes: layout.segments.map(segment => toTimelineBox(segment, lanesStartX)),
    };
  });
}

function toTimelineBox(segment: SegmentEntry, lanesStartX: number): TimelineBox {
  const x = lanesStartX + segment.lane * (LANE_WIDTH + LANE_GAP);
  const y = segment.topY + 1;
  const height = Math.max(ROW_HEIGHT - 2, segment.bottomY - segment.topY - 2);
  return {
    seq: segment.seqAnchor,
    memberSeqs: segment.memberSeqs,
    x,
    y,
    width: LANE_WIDTH,
    height,
    color: segment.color,
    pending: segment.pending,
    tooltip: formatSegmentTooltip(segment),
    connector:
      segment.linkedRailIndex === undefined
        ? null
        : { x1: getRailCenterX(segment.linkedRailIndex) + RAIL_COLUMN_WIDTH / 2, x2: x, y: y + height / 2 },
    pendingEdge: segment.pending ? { x1: x + 1, x2: x + LANE_WIDTH - 1, y: y + height } : null,
  };
}

function getRailCenterX(railIndex: number): number {
  return MARGIN_WIDTH + railIndex * RAIL_COLUMN_WIDTH + RAIL_COLUMN_WIDTH / 2;
}

function formatSegmentTooltip(segment: SegmentEntry): string {
  const parts = [segment.label];
  if (segment.detail !== undefined) {
    parts.push(segment.detail);
  }
  if (segment.pending) {
    parts.push('(pending)');
  }
  return parts.join(' · ');
}
