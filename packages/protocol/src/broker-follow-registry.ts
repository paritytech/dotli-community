// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { CachedBlock, SharedFollow } from "./broker-types.ts";
import { isJsonRpcObject } from "./broker-jsonrpc.ts";

interface LocalFollowToken {
  sessionId: string;
  followKey: string;
}

/**
 * Owns the shared `chainHead_v1_follow` state: the per-follow-key shared
 * subscription, the upstream<->shared binding, every session's local follow
 * token, and the block-pin ref-counts. Multiple sessions following the same
 * chain share one upstream follow, so this is where the ref-counting that
 * prevents double-unpin / premature-unfollow lives.
 */
export class FollowRegistry {
  private readonly sharedFollows = new Map<string, SharedFollow>();
  private readonly upstreamFollowTokens = new Map<string, SharedFollow>();
  private readonly localFollowTokens = new Map<string, LocalFollowToken>();

  /** Get the shared follow for a follow key, creating it if absent. */
  ensureShared(key: string): SharedFollow {
    let sharedFollow = this.sharedFollows.get(key);
    if (!sharedFollow) {
      sharedFollow = {
        key,
        upstreamToken: null,
        requestInFlight: false,
        localTokens: new Set<string>(),
        pendingLocals: [],
        finalizedBlockHashes: [],
        finalizedBlockRuntime: null,
        bestBlockHash: null,
        blocks: new Map<string, CachedBlock>(),
        pins: new Map<string, Set<string>>(),
      };
      this.sharedFollows.set(key, sharedFollow);
    }
    return sharedFollow;
  }

  getShared(key: string): SharedFollow | undefined {
    return this.sharedFollows.get(key);
  }

  deleteShared(key: string): void {
    this.sharedFollows.delete(key);
  }

  getLocal(token: string): LocalFollowToken | undefined {
    return this.localFollowTokens.get(token);
  }

  setLocal(token: string, entry: LocalFollowToken): void {
    this.localFollowTokens.set(token, entry);
  }

  deleteLocal(token: string): void {
    this.localFollowTokens.delete(token);
  }

  /** Snapshot of local-token entries; safe to mutate while iterating. */
  localEntries(): [string, LocalFollowToken][] {
    return [...this.localFollowTokens.entries()];
  }

  getByUpstream(upstreamToken: string): SharedFollow | undefined {
    return this.upstreamFollowTokens.get(upstreamToken);
  }

  bindUpstream(upstreamToken: string, sharedFollow: SharedFollow): void {
    this.upstreamFollowTokens.set(upstreamToken, sharedFollow);
  }

  unbindUpstream(upstreamToken: string): void {
    this.upstreamFollowTokens.delete(upstreamToken);
  }

  /** Record that `localToken` holds a pin on `hash` for this shared follow. */
  registerPin(
    sharedFollow: SharedFollow,
    localToken: string,
    hash: string,
  ): void {
    let holders = sharedFollow.pins.get(hash);
    if (!holders) {
      holders = new Set<string>();
      sharedFollow.pins.set(hash, holders);
    }
    holders.add(localToken);
  }

  /** Pin the blocks a follow event implies: `initialized` finalized blocks and `newBlock`. */
  registerPinsFromEvent(
    sharedFollow: SharedFollow,
    localToken: string,
    eventResult: unknown,
  ): void {
    if (!isJsonRpcObject(eventResult)) {
      return;
    }
    if (eventResult.event === "initialized") {
      const hashes = Array.isArray(eventResult.finalizedBlockHashes)
        ? eventResult.finalizedBlockHashes
        : [];
      for (const hash of hashes) {
        if (typeof hash === "string") {
          this.registerPin(sharedFollow, localToken, hash);
        }
      }
      return;
    }
    if (
      eventResult.event === "newBlock" &&
      typeof eventResult.blockHash === "string"
    ) {
      this.registerPin(sharedFollow, localToken, eventResult.blockHash);
    }
  }

  /**
   * Drop `localToken`'s hold on the given hashes (or all of them when null) and
   * return the hashes no session holds anymore — the ones to unpin upstream.
   */
  releasePins(
    sharedFollow: SharedFollow,
    localToken: string,
    hashes: string[] | null,
  ): string[] {
    const orphaned: string[] = [];
    const entries = hashes ?? [...sharedFollow.pins.keys()];
    for (const hash of entries) {
      const holders = sharedFollow.pins.get(hash);
      if (!holders) {
        continue;
      }
      if (!holders.delete(localToken)) {
        continue;
      }
      if (holders.size === 0) {
        sharedFollow.pins.delete(hash);
        orphaned.push(hash);
      }
    }
    return orphaned;
  }

  cacheSharedFollowEvent(
    sharedFollow: SharedFollow,
    eventResult: unknown,
  ): void {
    if (!isJsonRpcObject(eventResult)) {
      return;
    }

    const eventType =
      typeof eventResult.event === "string" ? eventResult.event : "";
    if (eventType === "initialized") {
      const hashes = Array.isArray(eventResult.finalizedBlockHashes)
        ? eventResult.finalizedBlockHashes.filter(
            (hash): hash is string => typeof hash === "string",
          )
        : [];
      sharedFollow.finalizedBlockHashes = hashes;
      sharedFollow.finalizedBlockRuntime =
        eventResult.finalizedBlockRuntime ?? null;
      sharedFollow.blocks.clear();
      sharedFollow.bestBlockHash = null;
      return;
    }

    if (eventType === "newBlock") {
      const blockHash =
        typeof eventResult.blockHash === "string"
          ? eventResult.blockHash
          : null;
      if (blockHash === null) {
        return;
      }
      sharedFollow.blocks.set(blockHash, {
        result: { ...eventResult },
        parentBlockHash:
          typeof eventResult.parentBlockHash === "string"
            ? eventResult.parentBlockHash
            : null,
      });
      return;
    }

    if (eventType === "bestBlockChanged") {
      sharedFollow.bestBlockHash =
        typeof eventResult.bestBlockHash === "string"
          ? eventResult.bestBlockHash
          : null;
      return;
    }

    if (eventType === "finalized") {
      const hashes = Array.isArray(eventResult.finalizedBlockHashes)
        ? eventResult.finalizedBlockHashes.filter(
            (hash): hash is string => typeof hash === "string",
          )
        : [];
      sharedFollow.finalizedBlockHashes = hashes;
      const pruned = Array.isArray(eventResult.prunedBlockHashes)
        ? eventResult.prunedBlockHashes.filter(
            (hash): hash is string => typeof hash === "string",
          )
        : [];
      for (const hash of pruned) {
        sharedFollow.blocks.delete(hash);
      }
    }
  }

  clear(): void {
    this.sharedFollows.clear();
    this.upstreamFollowTokens.clear();
    this.localFollowTokens.clear();
  }
}
