// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Every rail, tick and box is keyed by its stable seq, so the view updates a box in place as traffic streams in.

import type { EventSeq, StoredEvent } from './storedEvent.js';
import { computeGlobalYPositions } from './computeGlobalYPositions.js';
import { computeLayout, type SegmentEntry } from './computeLayout.js';
import { LANE_GAP, LANE_GUTTER, LANE_WIDTH, MARGIN_WIDTH, RAIL_COLUMN_WIDTH, ROW_HEIGHT } from './timelineGeometry.js';
import { partitionIntoSwimlanes } from './partitionIntoSwimlanes.js';

export type TimelineRail = {
  key: EventSeq;
  seq: EventSeq;
  x: number;
  y1: number;
  y2: number;
  color: string;
  pending: boolean;
  tooltip: string;
};

export type TimelineTick = {
  key: EventSeq;
  seq: EventSeq;
  cx: number;
  cy: number;
  color: string;
  tooltip: string;
};

export type TimelineBox = {
  key: EventSeq;
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
  marginX: number;
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
    const railsEndX = MARGIN_WIDTH + layout.railCount * RAIL_COLUMN_WIDTH;
    const lanesStartX = railsEndX + LANE_GUTTER;
    const lane: TimelineLane = {
      key: swimlane.key,
      header: swimlane.header,
      color: swimlane.color,
      width: lanesStartX + layout.laneCount * (LANE_WIDTH + LANE_GAP) + LANE_GAP,
      height: Math.max(ROW_HEIGHT, layout.totalHeight),
      marginX: MARGIN_WIDTH,
      railsEndX: layout.railCount > 0 ? railsEndX : null,
      rails: [],
      ticks: [],
      boxes: [],
    };
    for (const entry of layout.entries) {
      switch (entry.kind) {
        case 'rail':
          lane.rails.push({
            key: entry.seqAnchor,
            seq: entry.seqAnchor,
            x: getRailCenterX(entry.railIndex),
            y1: entry.topY + 2,
            y2: entry.bottomY - 2,
            color: entry.color,
            pending: entry.pending,
            tooltip: `follow · ${entry.label}${entry.pending ? ' (pending)' : ''}`,
          });
          break;
        case 'tick':
          lane.ticks.push({
            key: entry.seq,
            seq: entry.seq,
            cx: MARGIN_WIDTH / 2,
            cy: entry.y,
            color: entry.color,
            tooltip: entry.variant,
          });
          break;
        case 'segment':
          lane.boxes.push(toTimelineBox(entry, lanesStartX));
          break;
      }
    }
    return lane;
  });
}

function toTimelineBox(segment: SegmentEntry, lanesStartX: number): TimelineBox {
  const x = lanesStartX + segment.lane * (LANE_WIDTH + LANE_GAP);
  const y = segment.topY + 1;
  const height = Math.max(ROW_HEIGHT - 2, segment.bottomY - segment.topY - 2);
  let connector: TimelineBox['connector'] = null;
  if (segment.linkedRailIndex !== undefined) {
    connector = { x1: getRailCenterX(segment.linkedRailIndex) + RAIL_COLUMN_WIDTH / 2, x2: x, y: y + height / 2 };
  }
  return {
    key: segment.seqAnchor,
    seq: segment.seqAnchor,
    memberSeqs: segment.memberSeqs,
    x,
    y,
    width: LANE_WIDTH,
    height,
    color: segment.color,
    pending: segment.pending,
    tooltip: formatSegmentTooltip(segment),
    connector,
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
