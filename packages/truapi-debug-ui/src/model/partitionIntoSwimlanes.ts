// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { CHAIN_FOLLOW_START_TAG } from './chainFollowTags.js';
import { decodeChainAnnotations } from './decodeChainAnnotations.js';
import { formatChainDisplay } from './formatChainDisplay.js';
import { getHashColor } from './getHashColor.js';
import type { StoredEvent } from './storedEvent.js';

export type SwimlanePartition = {
  /** `chain-<genesisHash>`, `system` or `other`. */
  key: string;
  header: string;
  color: string;
  events: StoredEvent[];
};

type Params = {
  event: StoredEvent;
  /** The genesis hash each request id has carried so far. */
  requestIdToGenesis: Map<string, string>;
  /** The chains the product follows. */
  followedGenesis: Set<string>;
};

/** A followed chain, the system events, or everything else. */
type Swimlane = { kind: 'chain'; genesisHash: string } | { kind: 'system' } | { kind: 'other' };

type RankedPartition = SwimlanePartition & { rank: number };

/**
 * A chain gets its own lane only once followed, since a follow means the product actively uses it.
 * Other chain events fall into `other`. Never throws.
 */
export function partitionIntoSwimlanes(events: readonly StoredEvent[]): SwimlanePartition[] {
  // Follow-receives carry no genesisHash, so they inherit it through their requestId.
  const requestIdToGenesis = new Map<string, string>();
  const followedGenesis = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'truapi') {
      continue;
    }
    const annotations = decodeChainAnnotations(event.tag, event.payload);
    const genesisHash = annotations?.genesisHash;
    if (genesisHash !== undefined && !requestIdToGenesis.has(event.requestId)) {
      requestIdToGenesis.set(event.requestId, genesisHash);
    }
    if (event.tag === CHAIN_FOLLOW_START_TAG && genesisHash !== undefined) {
      followedGenesis.add(genesisHash);
    }
  }

  const lanes = new Map<string, RankedPartition>();
  for (const event of events) {
    const lane = describeSwimlane(getSwimlane({ event, requestIdToGenesis, followedGenesis }));
    const existing = lanes.get(lane.key);
    if (existing !== undefined) {
      existing.events.push(event);
      continue;
    }
    lanes.set(lane.key, { ...lane, events: [event] });
  }

  return Array.from(lanes.values())
    .sort((left, right) => {
      const rankDifference = left.rank - right.rank;
      if (rankDifference !== 0) {
        return rankDifference;
      }
      return left.key.localeCompare(right.key);
    })
    .map(({ key, header, color, events: laneEvents }) => ({ key, header, color, events: laneEvents }));
}

function getSwimlane({ event, requestIdToGenesis, followedGenesis }: Params): Swimlane {
  if (event.kind === 'system') {
    return { kind: 'system' };
  }
  if (!event.tag.startsWith('remote_chain_')) {
    return { kind: 'other' };
  }
  const genesisHash = requestIdToGenesis.get(event.requestId);
  if (genesisHash === undefined || !followedGenesis.has(genesisHash)) {
    return { kind: 'other' };
  }
  return { kind: 'chain', genesisHash };
}

/** The lane's key, header, colour and sort rank, chains first and `other` last. */
function describeSwimlane(lane: Swimlane) {
  switch (lane.kind) {
    case 'chain':
      return {
        key: `chain-${lane.genesisHash}`,
        header: formatChainDisplay(lane.genesisHash),
        color: getHashColor(lane.genesisHash, { saturation: 60, lightness: 60 }),
        rank: 1,
      };
    case 'system':
      return { key: 'system', header: 'System', color: 'var(--td-teal)', rank: 2 };
    case 'other':
      return { key: 'other', header: 'Other', color: 'var(--td-slate)', rank: 3 };
  }
}
