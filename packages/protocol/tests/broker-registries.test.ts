// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import { SessionRegistry } from "@dotli/protocol/broker-session-registry";
import { TokenRegistry } from "@dotli/protocol/broker-token-registry";
import { FollowRegistry } from "@dotli/protocol/broker-follow-registry";
import type { OwnedToken, Session } from "@dotli/protocol/broker-types";

function makeSession(id: string, wireMode: "string" | "object"): Session {
  return {
    id,
    onMessage: vi.fn(),
    ownedTokens: new Set<string>(),
    connected: true,
    wireMode,
  };
}

describe("SessionRegistry", () => {
  it("adds, gets, and deletes sessions keyed by id", () => {
    const reg = new SessionRegistry();
    const a = makeSession("a", "object");
    reg.add(a);
    expect(reg.has("a")).toBe(true);
    expect(reg.get("a")).toBe(a);
    expect(reg.size).toBe(1);
    expect(reg.ids()).toEqual(["a"]);
    reg.delete("a");
    expect(reg.has("a")).toBe(false);
    expect(reg.size).toBe(0);
  });

  it("encodes to a string for string-wire sessions", () => {
    const reg = new SessionRegistry();
    const s = makeSession("s", "string");
    reg.send(s, { hello: 1 });
    expect(s.onMessage).toHaveBeenCalledWith('{"hello":1}');
  });

  it("passes the object through for object-wire sessions", () => {
    const reg = new SessionRegistry();
    const s = makeSession("s", "object");
    const obj = { hello: 1 };
    reg.send(s, obj);
    expect(s.onMessage).toHaveBeenCalledWith(obj);
  });
});

describe("TokenRegistry", () => {
  const owned = (sessionId: string, localToken: string): OwnedToken => ({
    sessionId,
    localToken,
    releaseMethod: "transaction_v1_stop",
  });

  it("links a local token to an upstream token both ways", () => {
    const reg = new TokenRegistry();
    const o = owned("sess", "local:1");
    reg.link("local:1", "up:1", o);
    expect(reg.ownedByLocal("local:1")).toBe(o);
    expect(reg.ownedByUpstream("up:1")).toBe(o);
    expect(reg.upstreamForLocal("local:1")).toBe("up:1");
  });

  it("returns null from upstreamForLocal for an unknown local token", () => {
    const reg = new TokenRegistry();
    expect(reg.upstreamForLocal("nope")).toBeNull();
  });

  it("unlinkByLocal removes both sides and returns the upstream token", () => {
    const reg = new TokenRegistry();
    reg.link("local:1", "up:1", owned("sess", "local:1"));
    expect(reg.unlinkByLocal("local:1")).toBe("up:1");
    expect(reg.ownedByLocal("local:1")).toBeUndefined();
    expect(reg.ownedByUpstream("up:1")).toBeUndefined();
  });

  it("unlinkByLocal returns null for an unknown token", () => {
    const reg = new TokenRegistry();
    expect(reg.unlinkByLocal("ghost")).toBeNull();
  });

  it("clear empties both maps", () => {
    const reg = new TokenRegistry();
    reg.link("local:1", "up:1", owned("sess", "local:1"));
    reg.clear();
    expect(reg.ownedByLocal("local:1")).toBeUndefined();
    expect(reg.ownedByUpstream("up:1")).toBeUndefined();
  });
});

describe("FollowRegistry pins", () => {
  it("ensureShared is idempotent for the same key", () => {
    const reg = new FollowRegistry();
    const a = reg.ensureShared("k");
    const b = reg.ensureShared("k");
    expect(a).toBe(b);
    expect(reg.getShared("k")).toBe(a);
  });

  it("ref-counts pins: a block is orphaned only when its last holder releases", () => {
    const reg = new FollowRegistry();
    const follow = reg.ensureShared("k");
    reg.registerPin(follow, "tokenA", "0xblock");
    reg.registerPin(follow, "tokenB", "0xblock");

    // A releases — block still held by B, so nothing is orphaned.
    expect(reg.releasePins(follow, "tokenA", ["0xblock"])).toEqual([]);
    // B releases — now nobody holds it, so it's orphaned for upstream unpin.
    expect(reg.releasePins(follow, "tokenB", ["0xblock"])).toEqual(["0xblock"]);
  });

  it("releasePins with null releases every block this token holds", () => {
    const reg = new FollowRegistry();
    const follow = reg.ensureShared("k");
    reg.registerPin(follow, "tokenA", "0x1");
    reg.registerPin(follow, "tokenA", "0x2");
    expect(reg.releasePins(follow, "tokenA", null).sort()).toEqual([
      "0x1",
      "0x2",
    ]);
  });

  it("registerPinsFromEvent pins initialized finalized blocks", () => {
    const reg = new FollowRegistry();
    const follow = reg.ensureShared("k");
    reg.registerPinsFromEvent(follow, "tokenA", {
      event: "initialized",
      finalizedBlockHashes: ["0xa", "0xb"],
    });
    // Both should now be pinned by tokenA; releasing returns them as orphaned.
    expect(reg.releasePins(follow, "tokenA", null).sort()).toEqual([
      "0xa",
      "0xb",
    ]);
  });

  it("registerPinsFromEvent pins a newBlock hash", () => {
    const reg = new FollowRegistry();
    const follow = reg.ensureShared("k");
    reg.registerPinsFromEvent(follow, "tokenA", {
      event: "newBlock",
      blockHash: "0xnew",
    });
    expect(reg.releasePins(follow, "tokenA", null)).toEqual(["0xnew"]);
  });
});

describe("FollowRegistry cache", () => {
  it("initialized resets the snapshot and clears blocks", () => {
    const reg = new FollowRegistry();
    const follow = reg.ensureShared("k");
    follow.blocks.set("stale", { result: {}, parentBlockHash: null });
    reg.cacheSharedFollowEvent(follow, {
      event: "initialized",
      finalizedBlockHashes: ["0xfin"],
      finalizedBlockRuntime: { spec: 1 },
    });
    expect(follow.finalizedBlockHashes).toEqual(["0xfin"]);
    expect(follow.finalizedBlockRuntime).toEqual({ spec: 1 });
    expect(follow.blocks.size).toBe(0);
    expect(follow.bestBlockHash).toBeNull();
  });

  it("newBlock caches the block with its parent", () => {
    const reg = new FollowRegistry();
    const follow = reg.ensureShared("k");
    reg.cacheSharedFollowEvent(follow, {
      event: "newBlock",
      blockHash: "0xchild",
      parentBlockHash: "0xparent",
    });
    expect(follow.blocks.get("0xchild")?.parentBlockHash).toBe("0xparent");
  });

  it("finalized prunes pruned blocks from the cache", () => {
    const reg = new FollowRegistry();
    const follow = reg.ensureShared("k");
    follow.blocks.set("0xgone", { result: {}, parentBlockHash: null });
    follow.blocks.set("0xkeep", { result: {}, parentBlockHash: null });
    reg.cacheSharedFollowEvent(follow, {
      event: "finalized",
      finalizedBlockHashes: ["0xkeep"],
      prunedBlockHashes: ["0xgone"],
    });
    expect(follow.blocks.has("0xgone")).toBe(false);
    expect(follow.blocks.has("0xkeep")).toBe(true);
    expect(follow.finalizedBlockHashes).toEqual(["0xkeep"]);
  });

  it("bestBlockChanged updates the best block hash", () => {
    const reg = new FollowRegistry();
    const follow = reg.ensureShared("k");
    reg.cacheSharedFollowEvent(follow, {
      event: "bestBlockChanged",
      bestBlockHash: "0xbest",
    });
    expect(follow.bestBlockHash).toBe("0xbest");
  });
});
