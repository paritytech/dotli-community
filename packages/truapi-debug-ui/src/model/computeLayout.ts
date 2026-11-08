// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Rails are chainHead follow subscriptions, ticks their lifecycle events, boxes everything else.
// An operation's `follow_N` id names the Nth follow-start per (product, genesis), and its box
// ends at the follow event carrying its operationId.

import { isClosingTag, isRequestTag, isResponseTag, stripTagSuffix } from './callTag.js';
import { CHAIN_FOLLOW_RECEIVE_TAG, CHAIN_FOLLOW_START_TAG } from './chainFollowTags.js';
import type { GlobalYPositions } from './computeGlobalYPositions.js';
import { decodeChainAnnotations, type ChainAnnotations } from './decodeChainAnnotations.js';
import { formatChainDisplay } from './formatChainDisplay.js';
import { formatChainLabel } from './formatChainLabel.js';
import { formatChainOutcome } from './formatChainOutcome.js';
import { formatCount } from './formatCount.js';
import { getCorrelationKey } from './getCorrelationKey.js';
import { getEventLabel } from './getEventLabel.js';
import { getHashColor } from './getHashColor.js';
import { getRidColor } from './getRidColor.js';
import { findSystemEventFacts } from './systemEventFacts.js';
import type { EventSeq, StoredEvent, StoredSystemEvent, StoredTruapiEvent } from './storedEvent.js';
import { ROW_HEIGHT } from './timelineGeometry.js';

export type SegmentEntry = {
  kind: 'segment';
  seqAnchor: EventSeq;
  memberSeqs: EventSeq[];
  topY: number;
  bottomY: number;
  lane: number;
  color: string;
  label: string;
  detail?: string | undefined;
  /** The terminal event has not arrived yet. */
  pending: boolean;
  linkedRailIndex?: number | undefined;
};

export type RailEntry = {
  kind: 'rail';
  seqAnchor: EventSeq;
  memberSeqs: EventSeq[];
  topY: number;
  bottomY: number;
  railIndex: number;
  color: string;
  label: string;
  pending: boolean;
};

export type TickEntry = {
  kind: 'tick';
  seq: EventSeq;
  y: number;
  color: string;
  variant: string;
  /** Null when the rail was evicted. */
  linkedRailIndex: number | null;
};

export type TimelineEntry = SegmentEntry | RailEntry | TickEntry;

export type Layout = {
  entries: TimelineEntry[];
  laneCount: number;
  railCount: number;
  totalHeight: number;
  seqToEntryIndex: Map<EventSeq, number>;
};

type WorkingSegment = {
  seqAnchor: EventSeq;
  memberSeqs: EventSeq[];
  topY: number;
  bottomY: number;
  color: string;
  label: string;
  detail?: string | undefined;
  pending: boolean;
  linkedRailIndex?: number | undefined;
  startAt: number;
  endAt: number | null;
};

type BuildSegmentParams = {
  /** One TrUAPI call's events. */
  group: StoredTruapiEvent[];
  seqToY: Map<EventSeq, number>;
  /** Where a pending segment ends. */
  nowY: number;
  /** The terminal follow event of each chain operation, by operation id. */
  terminalByOperationId: Map<string, StoredTruapiEvent>;
  followKeyToRails: Map<string, RailEntry[]>;
};

type BuildSystemSegmentParams = {
  /** One host flow's events. */
  group: StoredSystemEvent[];
  seqToY: Map<EventSeq, number>;
  /** Where a segment whose last row has no Y ends. */
  nowY: number;
};

type GetBottomYParams = {
  seqToY: Map<EventSeq, number>;
  /** The seq of the segment's last row, or `undefined` while it has none. */
  endSeq: EventSeq | undefined;
  /** Where an open segment ends. */
  nowY: number;
};

type DescribeOperationBoxParams = {
  requestChain: ChainAnnotations | null;
  responseChain: ChainAnnotations | null | undefined;
  /** The operation's terminal follow event, once seen. */
  terminal: StoredTruapiEvent | undefined;
};

type LinkRailParams = {
  requestEvent: StoredTruapiEvent;
  chain: ChainAnnotations;
  followKeyToRails: Map<string, RailEntry[]>;
};

type BuildRailsParams = {
  events: readonly StoredEvent[];
  /** The events by correlation key. */
  groups: Map<string, StoredEvent[]>;
  seqToY: Map<EventSeq, number>;
  /** Where a rail with no `Stop` yet ends. */
  nowY: number;
};

type BuildRailsResult = {
  /** One rail per follow-start, in event order. */
  rails: RailEntry[];
  /** Each rail by the request id of its follow-start. */
  railByRequestId: Map<string, RailEntry>;
  /** The rails of each (product, genesis) pair, in follow-start order. */
  followKeyToRails: Map<string, RailEntry[]>;
};

type BuildSegmentsAndTicksParams = Omit<BuildSegmentParams, 'group'> & {
  /** The events by correlation key. */
  groups: Map<string, StoredEvent[]>;
  /** Each rail by the request id of its follow-start. */
  railByRequestId: Map<string, RailEntry>;
};

type BuildSegmentsAndTicksResult = {
  /** The segments, not yet placed in lanes. */
  segments: WorkingSegment[];
  ticks: TickEntry[];
};

type PackLanesResult = {
  /** The segments in placement order, each with its lane. */
  segments: SegmentEntry[];
  laneCount: number;
};

const LIFECYCLE_VARIANTS: ReadonlySet<string> = new Set([
  'Initialized',
  'NewBlock',
  'BestBlockChanged',
  'Finalized',
  'Stop',
]);

const OPERATION_TERMINAL_VARIANTS: ReadonlySet<string> = new Set([
  'OperationBodyDone',
  'OperationCallDone',
  'OperationStorageDone',
  'OperationError',
  'OperationInaccessible',
]);

// The panel's palette, resolved by the browser where the timeline draws, so a palette change reaches the chart.
const LIFECYCLE_COLORS: Record<string, string> = {
  Initialized: 'var(--td-focus)',
  NewBlock: 'var(--td-blue)',
  BestBlockChanged: 'var(--td-amber)',
  Finalized: 'var(--td-green)',
  Stop: 'var(--td-health-bad)',
};

/**
 * The rails, boxes and ticks of `events` on the rows `positions` gives, with lanes packed leftmost first. Throws only for
 * an empty group, which the grouping never makes.
 */
export function computeLayout(events: readonly StoredEvent[], positions: GlobalYPositions): Layout {
  const { seqToY, totalHeight } = positions;
  const nowY = totalHeight;
  const groups = groupByCorrelationKey(events);
  const { rails, railByRequestId, followKeyToRails } = buildRails({ events, groups, seqToY, nowY });
  const terminalByOperationId = indexOperationTerminals(events);
  const { segments, ticks } = buildSegmentsAndTicks({
    groups,
    railByRequestId,
    seqToY,
    nowY,
    terminalByOperationId,
    followKeyToRails,
  });
  const lanes = packLanes(segments, nowY);
  const entries: TimelineEntry[] = [...rails, ...lanes.segments, ...ticks];

  return {
    entries,
    laneCount: lanes.laneCount,
    railCount: rails.length,
    totalHeight,
    seqToEntryIndex: indexEntries(entries),
  };
}

function groupByCorrelationKey(events: readonly StoredEvent[]): Map<string, StoredEvent[]> {
  const groups = new Map<string, StoredEvent[]>();
  for (const event of events) {
    const key = getCorrelationKey(event);
    const group = groups.get(key);
    if (group !== undefined) {
      group.push(event);
    } else {
      groups.set(key, [event]);
    }
  }
  return groups;
}

function buildRails({ events, groups, seqToY, nowY }: BuildRailsParams): BuildRailsResult {
  const followKeyToRails = new Map<string, RailEntry[]>();
  const rails: RailEntry[] = [];
  const railByRequestId = new Map<string, RailEntry>();
  let nextRailIndex = 0;

  for (const event of events) {
    if (event.kind !== 'truapi') {
      continue;
    }
    if (event.tag !== CHAIN_FOLLOW_START_TAG) {
      continue;
    }
    const chain = decodeChainAnnotations(event.tag, event.payload);
    const key = getFollowKey(event.productId, chain?.genesisHash);
    const existing = followKeyToRails.get(key) ?? [];

    const group = groups.get(event.requestId) ?? [];
    const stop = group.find(member => {
      if (member.kind !== 'truapi') {
        return false;
      }
      if (member.tag !== CHAIN_FOLLOW_RECEIVE_TAG) {
        return false;
      }
      const memberChain = decodeChainAnnotations(member.tag, member.payload);
      return memberChain?.chainEventTag === 'Stop';
    });

    const ordinal = existing.length;
    const rail: RailEntry = {
      kind: 'rail',
      seqAnchor: event.seq,
      memberSeqs: [event.seq, ...(stop === undefined ? [] : [stop.seq])],
      topY: seqToY.get(event.seq) ?? 0,
      bottomY: getBottomY({ seqToY, endSeq: stop?.seq, nowY }),
      railIndex: nextRailIndex++,
      color: getHashColor(chain?.genesisHash ?? '', { saturation: 60, lightness: 55 }),
      label: formatRailLabel(chain?.genesisHash, ordinal),
      pending: stop === undefined,
    };
    rails.push(rail);
    railByRequestId.set(event.requestId, rail);
    existing.push(rail);
    followKeyToRails.set(key, existing);
  }
  return { rails, railByRequestId, followKeyToRails };
}

/** The terminal follow event of each chain operation, by operation id. The first one seen wins. */
function indexOperationTerminals(events: readonly StoredEvent[]): Map<string, StoredTruapiEvent> {
  const terminalByOperationId = new Map<string, StoredTruapiEvent>();
  for (const event of events) {
    if (event.kind !== 'truapi') {
      continue;
    }
    if (event.tag !== CHAIN_FOLLOW_RECEIVE_TAG) {
      continue;
    }
    const chain = decodeChainAnnotations(event.tag, event.payload);
    if (
      chain?.operationId === undefined ||
      chain.chainEventTag === undefined ||
      !OPERATION_TERMINAL_VARIANTS.has(chain.chainEventTag)
    ) {
      continue;
    }
    if (terminalByOperationId.has(chain.operationId)) {
      continue;
    }
    terminalByOperationId.set(chain.operationId, event);
  }
  return terminalByOperationId;
}

/** A follow subscription's group gives the ticks on its rail, and every other group gives at most one segment. */
function buildSegmentsAndTicks({
  groups,
  railByRequestId,
  seqToY,
  nowY,
  terminalByOperationId,
  followKeyToRails,
}: BuildSegmentsAndTicksParams): BuildSegmentsAndTicksResult {
  const segments: WorkingSegment[] = [];
  const ticks: TickEntry[] = [];
  for (const [correlationKey, group] of groups) {
    const rail = railByRequestId.get(correlationKey);
    if (rail !== undefined) {
      for (const event of group) {
        if (event.kind !== 'truapi') {
          continue;
        }
        if (event.tag !== CHAIN_FOLLOW_RECEIVE_TAG) {
          continue;
        }
        const chain = decodeChainAnnotations(event.tag, event.payload);
        if (chain?.chainEventTag === undefined || !LIFECYCLE_VARIANTS.has(chain.chainEventTag)) {
          continue;
        }
        ticks.push({
          kind: 'tick',
          seq: event.seq,
          y: (seqToY.get(event.seq) ?? 0) + ROW_HEIGHT / 2,
          color: LIFECYCLE_COLORS[chain.chainEventTag] ?? 'var(--td-fg-dim)',
          variant: chain.chainEventTag,
          linkedRailIndex: rail.railIndex,
        });
      }
      continue;
    }

    if (group[0]?.kind === 'system') {
      const systemGroup = group.filter((e): e is StoredSystemEvent => e.kind === 'system');
      segments.push(buildSystemSegment({ group: systemGroup, seqToY, nowY }));
      continue;
    }

    const truapiGroup = group.filter((e): e is StoredTruapiEvent => e.kind === 'truapi');
    if (truapiGroup.length === 0) {
      continue;
    }
    const segment = buildSegment({ group: truapiGroup, seqToY, nowY, terminalByOperationId, followKeyToRails });
    if (segment !== null) {
      segments.push(segment);
    }
  }
  return { segments, ticks };
}

/**
 * Puts each segment in the leftmost lane free at its top, taking segments by top Y and then by seq so the lanes come
 * out the same on every run. Returns the placed segments and the number of lanes used. Never throws.
 */
function packLanes(segments: readonly WorkingSegment[], nowY: number): PackLanesResult {
  const ordered = [...segments].sort((a, b) => a.topY - b.topY || a.seqAnchor - b.seqAnchor);
  const laneOccupiedUntil: number[] = [];
  const placed: SegmentEntry[] = [];
  for (const segment of ordered) {
    let lane = laneOccupiedUntil.findIndex(until => until <= segment.topY);
    if (lane === -1) {
      lane = laneOccupiedUntil.length;
      laneOccupiedUntil.push(0);
    }
    // A pending segment has no end yet, so it holds its lane to the bottom of the chart.
    laneOccupiedUntil[lane] = segment.pending ? nowY : segment.bottomY;

    placed.push({
      kind: 'segment',
      seqAnchor: segment.seqAnchor,
      memberSeqs: segment.memberSeqs,
      topY: segment.topY,
      bottomY: segment.bottomY,
      lane,
      color: segment.color,
      label: segment.label,
      detail: segment.detail,
      pending: segment.pending,
      linkedRailIndex: segment.linkedRailIndex,
    });
  }
  return { segments: placed, laneCount: laneOccupiedUntil.length };
}

function indexEntries(entries: readonly TimelineEntry[]): Map<EventSeq, number> {
  const seqToEntryIndex = new Map<EventSeq, number>();
  for (const [index, entry] of entries.entries()) {
    if (entry.kind === 'tick') {
      seqToEntryIndex.set(entry.seq, index);
      continue;
    }
    for (const seq of entry.memberSeqs) {
      seqToEntryIndex.set(seq, index);
    }
  }
  return seqToEntryIndex;
}

function buildSegment({
  group,
  seqToY,
  nowY,
  terminalByOperationId,
  followKeyToRails,
}: BuildSegmentParams): WorkingSegment | null {
  const sorted = sortBySeq(group);
  const first = sorted[0];
  if (first === undefined) {
    return null;
  }

  // Subscriptions have no bounded response time to draw. chainHead.follow is a rail instead.
  const hasRequest = sorted.some(e => isRequestTag(e.tag));
  if (!hasRequest) {
    return null;
  }

  const chain = decodeChainAnnotations(first.tag, first.payload);
  const isOperationStarter =
    chain?.kind === 'head-body-request' ||
    chain?.kind === 'head-storage-request' ||
    chain?.kind === 'head-call-request';

  // The response only carries the operationId. The operation ends at its terminal follow event.
  if (isOperationStarter) {
    const response = sorted.find(e => e.seq !== first.seq && isResponseTag(e.tag));
    const responseChain = response === undefined ? undefined : decodeChainAnnotations(response.tag, response.payload);
    const operationId = responseChain?.operationId;

    const linkedRailIndex = linkRail({ requestEvent: first, chain, followKeyToRails });

    const terminal = operationId !== undefined ? terminalByOperationId.get(operationId) : undefined;
    const memberSeqs: EventSeq[] = [first.seq];
    if (response !== undefined) {
      memberSeqs.push(response.seq);
    }
    if (terminal !== undefined) {
      memberSeqs.push(terminal.seq);
    }

    const endSeq = terminal?.seq ?? response?.seq;
    const pending = terminal === undefined && (response === undefined || responseChain?.outcome === 'started');

    return {
      seqAnchor: first.seq,
      memberSeqs,
      topY: seqToY.get(first.seq) ?? 0,
      bottomY: getBottomY({ seqToY, endSeq, nowY }),
      color: getRidColor(first.requestId),
      label: formatChainLabel(chain),
      detail: describeOperationBox({ requestChain: chain, responseChain, terminal }),
      pending,
      linkedRailIndex,
      startAt: first.receivedAt,
      endAt: terminal?.receivedAt ?? response?.receivedAt ?? null,
    };
  }

  // Matched by suffix because terminators travel in both directions.
  const hasTerminator = sorted.some(e => isClosingTag(e.tag));
  const last = sorted.at(-1) ?? first;
  const label = chain === null ? formatTagLabel(first.tag) : formatChainLabel(chain);

  return {
    seqAnchor: first.seq,
    memberSeqs: sorted.map(e => e.seq),
    topY: seqToY.get(first.seq) ?? 0,
    bottomY: getBottomY({ seqToY, endSeq: last.seq, nowY }),
    color: getRidColor(first.requestId),
    label,
    detail: chain?.blockHash !== undefined ? formatBlockDetail(chain.blockHash) : undefined,
    pending: !hasTerminator,
    startAt: first.receivedAt,
    endAt: hasTerminator ? last.receivedAt : null,
  };
}

/** A single-event flow becomes a one-row pill, so a point-in-time event still holds a lane at its Y. */
function buildSystemSegment({ group, seqToY, nowY }: BuildSystemSegmentParams): WorkingSegment {
  const sorted = sortBySeq(group);
  const first = sorted[0];
  if (first === undefined) {
    throw new Error('Empty system flow group in the timeline layout');
  }
  const last = sorted.at(-1) ?? first;
  const pending = sorted.length > 1 && !sorted.some(e => isSystemFlowTerminator(e));
  const label = getEventLabel(first).replace(/_/g, '.');
  return {
    seqAnchor: first.seq,
    memberSeqs: sorted.map(e => e.seq),
    topY: seqToY.get(first.seq) ?? 0,
    bottomY: getBottomY({ seqToY, endSeq: last.seq, nowY }),
    color: getHashColor(first.flowId, { saturation: 60, lightness: 62 }),
    label,
    detail: describeSystemSegment(first, sorted),
    pending,
    startAt: first.receivedAt,
    endAt: pending ? null : last.receivedAt,
  };
}

function describeSystemSegment(first: StoredSystemEvent, all: StoredSystemEvent[]): string | undefined {
  if (all.length === 1) {
    return undefined;
  }
  return `${first.layer}·${formatCount(all.length, 'step')}`;
}

function isSystemFlowTerminator(event: StoredSystemEvent): boolean {
  // A sandbox of another release can send a name the union lacks, which ends no flow.
  return findSystemEventFacts(event)?.endsFlow ?? false;
}

function describeOperationBox({
  requestChain,
  responseChain,
  terminal,
}: DescribeOperationBoxParams): string | undefined {
  const parts: string[] = [];
  if (requestChain?.blockHash !== undefined) {
    parts.push(formatBlockDetail(requestChain.blockHash));
  }
  const response = describeOperationResponse(responseChain);
  if (response !== undefined) {
    parts.push(response);
  }
  if (terminal !== undefined) {
    const terminalChain = decodeChainAnnotations(terminal.tag, terminal.payload);
    if (terminalChain?.chainEventTag !== undefined) {
      parts.push(`then ${terminalChain.chainEventTag}`);
    }
  }
  return parts.length === 0 ? undefined : parts.join(' · ');
}

function describeOperationResponse(responseChain: ChainAnnotations | null | undefined): string | undefined {
  if (responseChain?.operationId !== undefined) {
    return `op ${formatHexHead(responseChain.operationId)}`;
  }
  if (responseChain === null || responseChain === undefined) {
    return undefined;
  }
  return formatChainOutcome(responseChain);
}

function linkRail({ requestEvent, chain, followKeyToRails }: LinkRailParams): number | undefined {
  const syntheticId = chain.followSubscriptionId;
  if (syntheticId === undefined) {
    return undefined;
  }
  const key = getFollowKey(requestEvent.productId, chain.genesisHash);
  const rails = followKeyToRails.get(key);
  if (rails === undefined || rails.length === 0) {
    return undefined;
  }
  const match = /^follow_(\d+)$/.exec(syntheticId);
  if (match === null) {
    return undefined;
  }
  const ordinal = Number(match[1]);
  // The follow-start may have been evicted, so fall back to the last rail for this pair.
  const rail = rails[ordinal] ?? rails.at(-1);
  return rail?.railIndex;
}

function getFollowKey(productId: string | undefined, genesisHash: string | undefined): string {
  return `${productId ?? '__anon'}|${genesisHash ?? '__unknown'}`;
}

function formatRailLabel(genesisHash: string | undefined, ordinal: number): string {
  const prefix = genesisHash === undefined ? '(no chain)' : formatChainDisplay(genesisHash);
  return ordinal === 0 ? prefix : `${prefix} #${String(ordinal)}`;
}

/** The bottom of the row of `endSeq`, or `nowY` while the segment is open. Never throws. */
function getBottomY({ seqToY, endSeq, nowY }: GetBottomYParams): number {
  if (endSeq === undefined) {
    return nowY;
  }
  return (seqToY.get(endSeq) ?? nowY) + ROW_HEIGHT;
}

function sortBySeq<Event extends StoredEvent>(events: readonly Event[]): Event[] {
  return [...events].sort((a, b) => a.seq - b.seq);
}

function formatBlockDetail(blockHash: string): string {
  return `blk ${formatHexHead(blockHash)}`;
}

function formatHexHead(hex: string): string {
  if (hex.length > 8) {
    return `${hex.slice(0, 6)}…`;
  }
  return hex;
}

function formatTagLabel(tag: string): string {
  // The side prefix goes first, so a tag that is only a prefix and a suffix keeps its suffix word.
  const name = stripTagSuffix(tag.replace(/^(remote_|host_)/, ''));
  // Dots let the narrow box label wrap across lines.
  return name.replace(/_/g, '.');
}
