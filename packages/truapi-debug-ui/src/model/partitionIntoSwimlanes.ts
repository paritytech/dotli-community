// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { CHAIN_FOLLOW_START_TAG } from './chainFollowTags.js';
import { decodeChainAnnotations } from './decodeChainAnnotations.js';
import { formatChainDisplay } from './formatChainDisplay.js';
import { getCorrelationKey } from './getCorrelationKey.js';
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
  /** The genesis hash each call has carried so far. */
  genesisByCall: Map<string, string>;
  /** The chains the product follows. */
  followedGenesis: Set<string>;
};

type RankedPartition = SwimlanePartition & { rank: number };

/**
 * A chain gets its own lane only once followed, since a follow means the product actively uses it.
 * Other chain events fall into `other`.
 */
export function partitionIntoSwimlanes(events: readonly StoredEvent[]): SwimlanePartition[] {
  // Follow-receives carry no genesisHash, so they inherit it through their call.
  const genesisByCall = new Map<string, string>();
  const followedGenesis = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'truapi') {
      continue;
    }
    const annotations = decodeChainAnnotations(event.tag, event.payload);
    const genesisHash = annotations?.genesisHash;
    const call = getCorrelationKey(event);
    if (genesisHash !== undefined && !genesisByCall.has(call)) {
      genesisByCall.set(call, genesisHash);
    }
    if (event.tag === CHAIN_FOLLOW_START_TAG && genesisHash !== undefined) {
      followedGenesis.add(genesisHash);
    }
  }

  const lanes = new Map<string, RankedPartition>();
  for (const event of events) {
    const lane = describeSwimlane({ event, genesisByCall, followedGenesis });
    const existing = lanes.get(lane.key);
    if (existing !== undefined) {
      existing.events.push(event);
      continue;
    }
    lanes.set(lane.key, { ...lane, events: [event] });
  }

  return Array.from(lanes.values())
    .sort((left, right) => left.rank - right.rank || left.key.localeCompare(right.key))
    .map(({ key, header, color, events: laneEvents }) => ({ key, header, color, events: laneEvents }));
}

/** The key, header, colour and sort rank of the lane `event` goes in: a followed chain, then system, then other. */
function describeSwimlane({ event, genesisByCall, followedGenesis }: Params) {
  if (event.kind === 'system') {
    return { key: 'system', header: 'System', color: 'var(--td-teal)', rank: 2 };
  }
  const genesisHash = event.tag.startsWith('remote_chain_') ? genesisByCall.get(getCorrelationKey(event)) : undefined;
  if (genesisHash === undefined || !followedGenesis.has(genesisHash)) {
    return { key: 'other', header: 'Other', color: 'var(--td-slate)', rank: 3 };
  }
  return {
    key: `chain-${genesisHash}`,
    header: formatChainDisplay(genesisHash),
    color: getHashColor(genesisHash, { saturation: 60, lightness: 60 }),
    rank: 1,
  };
}
