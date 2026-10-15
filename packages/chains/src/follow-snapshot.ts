// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What one shared chainHead follow has told its sessions so far, and which of its blocks each holder still pins. A
// session that joins late is replayed from it, and a block is unpinned upstream only once no holder pins it.

import { isRecord, stringsOf } from './json-shape.js';

/**
 * Pins the blocks a later session is replayed. Sessions unpin freely, and without this the next session to join would
 * be told of a block the node already unpinned and refuses to read.
 */
const SNAPSHOT_HOLDER = 'snapshot';

export interface FollowSnapshot {
  /** Records one upstream follow event, and returns the blocks it leaves no holder pinning. */
  record(event: unknown): string[];
  /** Pins for `holder` the blocks `event` announces: the finalized ones of `initialized`, and a `newBlock`. */
  pinEvent(holder: string, event: unknown): void;
  /** Drops `holder`'s pins on `hashes`, or on every block when null, and returns the blocks no holder pins anymore. */
  release(holder: string, hashes: readonly string[] | null): string[];
  /** The events that bring a joining `holder` up to date, with their blocks pinned for it. */
  replayFor(holder: string): Record<string, unknown>[];
}

export function createFollowSnapshot(): FollowSnapshot {
  // The newest finalized block alone, the base a joining session's replay starts from.
  let finalizedBlockHash: string | null = null;
  let finalizedBlockRuntime: unknown = null;
  let bestBlockHash: string | null = null;
  // The unfinalized blocks above the newest finalized one, as the node announced them.
  const blocks = new Map<string, Record<string, unknown>>();
  const pins = new Map<string, Set<string>>();

  function pin(holder: string, hash: string): void {
    let holders = pins.get(hash);
    if (holders === undefined) {
      holders = new Set<string>();
      pins.set(hash, holders);
    }
    holders.add(holder);
  }

  function release(holder: string, hashes: readonly string[] | null): string[] {
    const orphaned: string[] = [];
    for (const hash of hashes ?? [...pins.keys()]) {
      const holders = pins.get(hash);
      if (holders?.delete(holder) !== true) {
        continue;
      }
      if (holders.size === 0) {
        pins.delete(hash);
        orphaned.push(hash);
      }
    }
    return orphaned;
  }

  function pinEvent(holder: string, event: unknown): void {
    if (!isRecord(event)) {
      return;
    }
    if (event['event'] === 'initialized') {
      for (const hash of stringsOf(event['finalizedBlockHashes'])) {
        pin(holder, hash);
      }
      return;
    }
    if (event['event'] === 'newBlock' && typeof event['blockHash'] === 'string') {
      pin(holder, event['blockHash']);
    }
  }

  function recordFinalized(event: Record<string, unknown>): string[] {
    const hashes = stringsOf(event['finalizedBlockHashes']);
    const newest = hashes.at(-1);
    if (newest === undefined) {
      return [];
    }
    for (const hash of hashes) {
      const newRuntime = blocks.get(hash)?.['newRuntime'];
      if (newRuntime !== undefined && newRuntime !== null) {
        finalizedBlockRuntime = newRuntime;
      }
    }
    const dropped = [
      ...(finalizedBlockHash === null ? [] : [finalizedBlockHash]),
      ...hashes.slice(0, -1),
      ...stringsOf(event['prunedBlockHashes']),
    ];
    for (const hash of [...dropped, newest]) {
      blocks.delete(hash);
    }
    pin(SNAPSHOT_HOLDER, newest);
    finalizedBlockHash = newest;
    return release(SNAPSHOT_HOLDER, dropped);
  }

  function record(event: unknown): string[] {
    if (!isRecord(event)) {
      return [];
    }
    if (event['event'] === 'initialized') {
      const newest = stringsOf(event['finalizedBlockHashes']).at(-1) ?? null;
      finalizedBlockHash = newest;
      finalizedBlockRuntime = event['finalizedBlockRuntime'] ?? null;
      blocks.clear();
      bestBlockHash = null;
      if (newest !== null) {
        pin(SNAPSHOT_HOLDER, newest);
      }
      return [];
    }
    if (event['event'] === 'newBlock') {
      if (typeof event['blockHash'] === 'string') {
        blocks.set(event['blockHash'], { ...event });
        pin(SNAPSHOT_HOLDER, event['blockHash']);
      }
      return [];
    }
    if (event['event'] === 'bestBlockChanged') {
      bestBlockHash = typeof event['bestBlockHash'] === 'string' ? event['bestBlockHash'] : null;
      return [];
    }
    if (event['event'] === 'finalized') {
      return recordFinalized(event);
    }
    return [];
  }

  function replayFor(holder: string): Record<string, unknown>[] {
    if (finalizedBlockHash === null) {
      return [];
    }
    pin(holder, finalizedBlockHash);
    const events: Record<string, unknown>[] = [
      { event: 'initialized', finalizedBlockHashes: [finalizedBlockHash], finalizedBlockRuntime },
    ];
    // The node announces a parent before its children, so announcement order is parents first, forks included.
    for (const block of blocks.values()) {
      pinEvent(holder, block);
      events.push({ ...block });
    }
    if (bestBlockHash !== null) {
      events.push({ event: 'bestBlockChanged', bestBlockHash });
    }
    return events;
  }

  return { record, pinEvent, release, replayFor };
}
