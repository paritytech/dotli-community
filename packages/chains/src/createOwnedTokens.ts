// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { OwnedToken, Session } from './brokerMessages.js';

type MapTokenParams = {
  /** The session that opened the subscription, and now owns its local token. */
  session: Session;
  /** The token the upstream answered with. */
  upstreamToken: string;
  /** The method that ends the subscription upstream once its last owner releases it. */
  releaseMethod: string;
};

/**
 * The upstream subscriptions sessions own, such as follows, transaction watches and statement subscriptions, each under a local
 * token of its own. Several sessions can own one upstream subscription, which ends upstream with its last owner.
 */
export function createOwnedTokens() {
  const localToOwned = new Map<string, OwnedToken>();
  const upstreamToOwned = new Map<string, Set<OwnedToken>>();
  // Never reset, so no two local tokens of the broker's life are the same.
  let tokenCounter = 0;

  function mapToken({ session, upstreamToken, releaseMethod }: MapTokenParams): string {
    const localToken = `token:${tokenCounter.toString(36)}:${session.id}`;
    tokenCounter += 1;
    const owned: OwnedToken = { session, localToken, upstreamToken, releaseMethod };
    localToOwned.set(localToken, owned);
    let owners = upstreamToOwned.get(upstreamToken);
    if (owners === undefined) {
      owners = new Set<OwnedToken>();
      upstreamToOwned.set(upstreamToken, owners);
    }
    owners.add(owned);
    return localToken;
  }

  function find(localToken: string): Readonly<OwnedToken> | undefined {
    return localToOwned.get(localToken);
  }

  function has(localToken: string): boolean {
    return localToOwned.has(localToken);
  }

  function listOwners(upstreamToken: string): Readonly<OwnedToken>[] {
    return [...(upstreamToOwned.get(upstreamToken) ?? [])];
  }

  function listSessionTokens(session: Session): Readonly<OwnedToken>[] {
    return [...localToOwned.values()].filter(owned => owned.session === session);
  }

  function countUpstream(releaseMethod: string): number {
    let count = 0;
    for (const owners of upstreamToOwned.values()) {
      const [first] = owners;
      if (first?.releaseMethod === releaseMethod) {
        count += 1;
      }
    }
    return count;
  }

  function release(localToken: string): boolean {
    const owned = localToOwned.get(localToken);
    if (owned === undefined) {
      return false;
    }
    localToOwned.delete(localToken);
    const owners = upstreamToOwned.get(owned.upstreamToken);
    owners?.delete(owned);
    if ((owners?.size ?? 0) > 0) {
      return false;
    }
    upstreamToOwned.delete(owned.upstreamToken);
    return true;
  }

  function clear(): void {
    localToOwned.clear();
    upstreamToOwned.clear();
  }

  return {
    /** Maps an upstream subscription to a new local token the session owns, as `token:<counter in base 36>:<session id>`. */
    mapToken,
    /** The subscription a local token names, or undefined for a token no session owns. */
    find,
    /** Whether a session still owns `localToken`. */
    has,
    /** The owned tokens of `upstreamToken`, as a copy. Empty for a token nobody owns. */
    listOwners,
    /** The owned tokens of `session` in the order they were mapped, as a copy. */
    listSessionTokens,
    /** The number of upstream subscriptions whose release is `releaseMethod`, each counted once however many own it. */
    countUpstream,
    /**
     * Ends `localToken`'s ownership, and returns whether it was the last owner of its upstream subscription, which the
     * caller then ends upstream. False for a token no session owns.
     */
    release,
    /** Forgets every owned subscription. Its local tokens are never reused. */
    clear,
  };
}
