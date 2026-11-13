// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Rails are chainHead follow subscriptions, ticks their lifecycle events, boxes everything else. An operation's box
// ends at the follow event carrying its operationId, and links to the rail of the subscription that event came on.

import { isClosingTag, isRequestTag, isResponseTag, stripTagSuffix } from './callTag.js';
import { CHAIN_FOLLOW_RECEIVE_TAG, CHAIN_FOLLOW_START_TAG } from './chainFollowTags.js';
import type { GlobalYPositions } from './computeGlobalYPositions.js';
import { decodeChainAnnotations, isOperationStarter, type ChainAnnotations } from './decodeChainAnnotations.js';
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
  seqAnchor: EventSeq;
  topY: number;
  bottomY: number;
  railIndex: number;
  color: string;
  label: string;
  pending: boolean;
};

export type TickEntry = {
  seq: EventSeq;
  y: number;
  color: string;
  variant: string;
};

export type Layout = {
  rails: RailEntry[];
  /** Boxes, each in its lane. */
  segments: SegmentEntry[];
  ticks: TickEntry[];
  laneCount: number;
};

/** A segment before it is placed in a lane. */
type WorkingSegment = Omit<SegmentEntry, 'lane'>;

/** One call's or one flow's events, in order. Never empty. */
type Group<Event> = [Event, ...Event[]];

/** An event a follow subscription delivered, with its ChainHeadEvent variant. */
type FollowReceive = {
  event: StoredTruapiEvent;
  variant: string;
};

/** What the chain follows tell an operation's box. */
type Follows = {
  /** The terminal follow event of each chain operation, by its operation key. */
  terminals: Map<string, FollowReceive>;
  /** Each rail by the call key of its follow-start. */
  railByCall: Map<string, RailEntry>;
  /** The rails of each (product, genesis) pair, in follow-start order. */
  railsByFollowKey: Map<string, RailEntry[]>;
};

type DescribeOperationBoxParams = {
  requestChain: ChainAnnotations;
  /** Null until the response arrives. */
  responseChain: ChainAnnotations | null;
  /** The operation's terminal follow event, once seen. */
  terminal: FollowReceive | undefined;
};

type FindOperationRailParams = {
  /** The operation's request. */
  first: StoredTruapiEvent;
  chain: ChainAnnotations;
  /** The operation's terminal follow event, once seen. */
  terminal: FollowReceive | undefined;
  follows: Follows;
};

const OPERATION_TERMINAL_VARIANTS: ReadonlySet<string> = new Set([
  'OperationBodyDone',
  'OperationCallDone',
  'OperationStorageDone',
  'OperationError',
  'OperationInaccessible',
]);

// The follow lifecycle events drawn as ticks, in the panel's palette. The browser resolves it where the timeline
// draws, so a palette change reaches the chart.
const LIFECYCLE_COLORS: Partial<Record<string, string>> = {
  Initialized: 'var(--td-focus)',
  NewBlock: 'var(--td-blue)',
  BestBlockChanged: 'var(--td-amber)',
  Finalized: 'var(--td-green)',
  Stop: 'var(--td-health-bad)',
};

/**
 * The rails, boxes and ticks of `events` on the rows `positions` gives, with lanes packed leftmost first. `events` is
 * in seq order, as a store lists them.
 */
export function computeLayout(events: readonly StoredEvent[], positions: GlobalYPositions): Layout {
  const calls = new Map<string, Group<StoredTruapiEvent>>();
  const flows = new Map<string, Group<StoredSystemEvent>>();
  const receives = new Map<string, Group<FollowReceive>>();
  // The first terminal seen for an operation wins.
  const terminals = new Map<string, FollowReceive>();
  for (const event of events) {
    if (event.kind === 'system') {
      addToGroup(flows, event.flowId, event);
      continue;
    }
    const call = getCorrelationKey(event);
    addToGroup(calls, call, event);
    if (event.tag !== CHAIN_FOLLOW_RECEIVE_TAG) {
      continue;
    }
    const chain = decodeChainAnnotations(event.tag, event.payload);
    if (chain?.chainEventTag === undefined) {
      continue;
    }
    const receive = { event, variant: chain.chainEventTag };
    addToGroup(receives, call, receive);
    if (chain.operationId === undefined || !OPERATION_TERMINAL_VARIANTS.has(receive.variant)) {
      continue;
    }
    const operation = getOperationKey(event.productId, chain.operationId);
    if (!terminals.has(operation)) {
      terminals.set(operation, receive);
    }
  }

  const rails: RailEntry[] = [];
  const ticks: TickEntry[] = [];
  const follows: Follows = { terminals, railByCall: new Map(), railsByFollowKey: new Map() };
  for (const [call, [start]] of calls) {
    if (start.tag !== CHAIN_FOLLOW_START_TAG) {
      continue;
    }
    const genesisHash = decodeChainAnnotations(start.tag, start.payload)?.genesisHash;
    const followKey = getFollowKey(start.productId, genesisHash);
    const siblings = follows.railsByFollowKey.get(followKey) ?? [];
    const delivered = receives.get(call) ?? [];
    const stop = delivered.find(receive => receive.variant === 'Stop');
    const rail: RailEntry = {
      seqAnchor: start.seq,
      topY: positions.seqToY.get(start.seq) ?? 0,
      bottomY: getBottomY(positions, stop?.event.seq),
      railIndex: rails.length,
      color: getHashColor(genesisHash ?? '', { saturation: 60, lightness: 55 }),
      label: formatRailLabel(genesisHash, siblings.length),
      pending: stop === undefined,
    };
    rails.push(rail);
    follows.railByCall.set(call, rail);
    siblings.push(rail);
    follows.railsByFollowKey.set(followKey, siblings);
    for (const { event, variant } of delivered) {
      const color = LIFECYCLE_COLORS[variant];
      if (color !== undefined) {
        ticks.push({
          seq: event.seq,
          y: (positions.seqToY.get(event.seq) ?? 0) + ROW_HEIGHT / 2,
          color,
          variant,
        });
      }
    }
  }

  const segments: WorkingSegment[] = [];
  for (const [call, group] of calls) {
    // A follow subscription is its rail and ticks.
    if (follows.railByCall.has(call)) {
      continue;
    }
    const segment = buildSegment(group, positions, follows);
    if (segment !== null) {
      segments.push(segment);
    }
  }
  for (const flow of flows.values()) {
    segments.push(buildSystemSegment(flow, positions));
  }

  return { rails, ticks, ...packLanes(segments, positions.totalHeight) };
}

/** Appends `item` to the group of `key`. CAUTION: writes into `groups`. */
function addToGroup<Item>(groups: Map<string, Group<Item>>, key: string, item: Item): void {
  const group = groups.get(key);
  if (group === undefined) {
    groups.set(key, [item]);
  } else {
    group.push(item);
  }
}

/**
 * Puts each segment in the leftmost lane free at its top, taking segments by top Y and then by seq so the lanes come
 * out the same on every run. Returns the placed segments and the number of lanes used.
 */
function packLanes(segments: readonly WorkingSegment[], nowY: number) {
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
    placed.push({ ...segment, lane });
  }
  return { segments: placed, laneCount: laneOccupiedUntil.length };
}

/** A TrUAPI call's box, or null for a call with no request, such as a subscription, which has no response time. */
function buildSegment(
  call: Group<StoredTruapiEvent>,
  positions: GlobalYPositions,
  follows: Follows,
): WorkingSegment | null {
  const [first] = call;
  if (!call.some(e => isRequestTag(e.tag))) {
    return null;
  }

  const chain = decodeChainAnnotations(first.tag, first.payload);
  // The response only carries the operationId. The operation ends at its terminal follow event.
  if (chain !== null && isOperationStarter(chain.kind)) {
    const response = call.find(e => isResponseTag(e.tag));
    const responseChain = response === undefined ? null : decodeChainAnnotations(response.tag, response.payload);
    const operationId = responseChain?.operationId;
    const terminal =
      operationId === undefined ? undefined : follows.terminals.get(getOperationKey(first.productId, operationId));
    const memberSeqs: EventSeq[] = [first.seq];
    if (response !== undefined) {
      memberSeqs.push(response.seq);
    }
    if (terminal !== undefined) {
      memberSeqs.push(terminal.event.seq);
    }
    return {
      seqAnchor: first.seq,
      memberSeqs,
      topY: positions.seqToY.get(first.seq) ?? 0,
      bottomY: getBottomY(positions, terminal?.event.seq ?? response?.seq),
      color: getRidColor(first.requestId),
      label: formatChainLabel(chain),
      detail: describeOperationBox({ requestChain: chain, responseChain, terminal }),
      pending: terminal === undefined && (response === undefined || responseChain?.outcome === 'started'),
      linkedRailIndex: findOperationRail({ first, chain, terminal, follows })?.railIndex,
    };
  }

  // Matched by suffix because terminators travel in both directions.
  const hasTerminator = call.some(e => isClosingTag(e.tag));
  const last = call.at(-1) ?? first;
  return {
    seqAnchor: first.seq,
    memberSeqs: call.map(e => e.seq),
    topY: positions.seqToY.get(first.seq) ?? 0,
    bottomY: getBottomY(positions, last.seq),
    color: getRidColor(first.requestId),
    label: chain === null ? formatTagLabel(first.tag) : formatChainLabel(chain),
    detail: chain?.blockHash !== undefined ? formatBlockDetail(chain.blockHash) : undefined,
    pending: !hasTerminator,
  };
}

/** A single-event flow becomes a one-row pill, so a point-in-time event still holds a lane at its Y. */
function buildSystemSegment(flow: Group<StoredSystemEvent>, positions: GlobalYPositions): WorkingSegment {
  const [first] = flow;
  const last = flow.at(-1) ?? first;
  return {
    seqAnchor: first.seq,
    memberSeqs: flow.map(e => e.seq),
    topY: positions.seqToY.get(first.seq) ?? 0,
    bottomY: getBottomY(positions, last.seq),
    color: getHashColor(first.flowId, { saturation: 60, lightness: 62 }),
    label: getEventLabel(first).replace(/_/g, '.'),
    detail: flow.length === 1 ? undefined : `${first.layer}·${formatCount(flow.length, 'step')}`,
    // A sandbox of another release can send a name the union lacks, which ends no flow.
    pending: flow.length > 1 && !flow.some(e => findSystemEventFacts(e)?.endsFlow === true),
  };
}

function describeOperationBox({
  requestChain,
  responseChain,
  terminal,
}: DescribeOperationBoxParams): string | undefined {
  const parts: string[] = [];
  if (requestChain.blockHash !== undefined) {
    parts.push(formatBlockDetail(requestChain.blockHash));
  }
  if (responseChain?.operationId !== undefined) {
    parts.push(`op ${formatHexHead(responseChain.operationId)}`);
  } else if (responseChain !== null) {
    const outcome = formatChainOutcome(responseChain);
    if (outcome !== undefined) {
      parts.push(outcome);
    }
  }
  if (terminal !== undefined) {
    parts.push(`then ${terminal.variant}`);
  }
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/**
 * The rail an operation runs on. A finished operation names it through its terminal's subscription. A pending one has
 * only its `follow_N` id, the Nth follow-start of its (product, genesis) pair, read against the rails still kept, so it
 * falls back to the pair's last rail.
 */
function findOperationRail({ first, chain, terminal, follows }: FindOperationRailParams): RailEntry | undefined {
  if (terminal !== undefined) {
    // An evicted follow-start leaves no rail, and no other rail is this one.
    return follows.railByCall.get(getCorrelationKey(terminal.event));
  }
  const match = /^follow_(\d+)$/.exec(chain.followSubscriptionId ?? '');
  const rails = follows.railsByFollowKey.get(getFollowKey(first.productId, chain.genesisHash));
  if (match === null || rails === undefined) {
    return undefined;
  }
  return rails[Number(match[1])] ?? rails.at(-1);
}

/** An operation id is the node's, so two products' operations can share one. */
function getOperationKey(productId: string | undefined, operationId: string): string {
  return `${productId ?? '__anon'}|${operationId}`;
}

function getFollowKey(productId: string | undefined, genesisHash: string | undefined): string {
  return `${productId ?? '__anon'}|${genesisHash ?? '__unknown'}`;
}

function formatRailLabel(genesisHash: string | undefined, ordinal: number): string {
  const prefix = genesisHash === undefined ? '(no chain)' : formatChainDisplay(genesisHash);
  return ordinal === 0 ? prefix : `${prefix} #${String(ordinal)}`;
}

/** The bottom of the row of `endSeq`, or the chart's end while the box or rail is open. */
function getBottomY({ seqToY, totalHeight }: GlobalYPositions, endSeq: EventSeq | undefined): number {
  if (endSeq === undefined) {
    return totalHeight;
  }
  return (seqToY.get(endSeq) ?? totalHeight) + ROW_HEIGHT;
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
