// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { OwnedToken } from "./broker-types.ts";

/**
 * Keeps the local-token <-> upstream-token mapping for session-owned
 * subscriptions (e.g. `transaction_v1_broadcast`, `statement_subscribe`)
 * consistent. The broker mints token strings and assigns release methods;
 * this registry only guards the dual-map invariant so the two never drift.
 */
export class TokenRegistry {
  private readonly localToOwned = new Map<string, OwnedToken>();
  private readonly upstreamToOwned = new Map<string, OwnedToken>();

  /** Link a freshly minted local token to its upstream token. */
  link(localToken: string, upstreamToken: string, owned: OwnedToken): void {
    this.localToOwned.set(localToken, owned);
    this.upstreamToOwned.set(upstreamToken, owned);
  }

  ownedByLocal(localToken: string): OwnedToken | undefined {
    return this.localToOwned.get(localToken);
  }

  ownedByUpstream(upstreamToken: string): OwnedToken | undefined {
    return this.upstreamToOwned.get(upstreamToken);
  }

  /** Reverse lookup: the upstream token currently bound to `localToken`. */
  upstreamForLocal(localToken: string): string | null {
    for (const [upstreamToken, owned] of this.upstreamToOwned.entries()) {
      if (owned.localToken === localToken) {
        return upstreamToken;
      }
    }
    return null;
  }

  /**
   * Drop `localToken` and the upstream token it maps to. Returns the unlinked
   * upstream token so the caller can notify upstream, or null when the local
   * token was unknown or had no upstream mapping (the local entry is still
   * removed in the former case, matching the broker's prior behavior).
   */
  unlinkByLocal(localToken: string): string | null {
    if (!this.localToOwned.has(localToken)) {
      return null;
    }
    this.localToOwned.delete(localToken);
    let upstreamTokenToDelete: string | null = null;
    for (const [upstreamToken, candidate] of this.upstreamToOwned.entries()) {
      if (candidate.localToken === localToken) {
        upstreamTokenToDelete = upstreamToken;
        break;
      }
    }
    if (upstreamTokenToDelete === null) {
      return null;
    }
    this.upstreamToOwned.delete(upstreamTokenToDelete);
    return upstreamTokenToDelete;
  }

  clear(): void {
    this.localToOwned.clear();
    this.upstreamToOwned.clear();
  }
}
