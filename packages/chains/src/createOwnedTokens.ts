// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { OwnedToken, SendReleaseParams, SessionTokenParams } from './brokerMessages.js';
import type { LocalTokenIds } from './createLocalTokenIds.js';

type Params = {
  /** Numbers the local token each owned subscription gets. */
  localTokenIds: LocalTokenIds;
  /** Adds a token to its session's set. Does nothing for a session that has gone. */
  addSessionToken: (params: SessionTokenParams) => void;
  /** Drops a token from its session's set. Does nothing for a session that has gone. */
  deleteSessionToken: (params: SessionTokenParams) => void;
  /** Sends a release upstream that no session waits on. */
  sendRelease: (params: SendReleaseParams) => void;
  /** Logs broker traffic at debug level. */
  log: (message: string) => void;
};

type MapTokenParams = {
  /** The session that opened the subscription, and now owns its local token. */
  sessionId: string;
  /** The token the upstream answered with. */
  upstreamToken: string;
  /** The method that ends the subscription upstream once its last owner releases it. */
  releaseMethod: string;
  /** The method that opened it, for the debug log. */
  method: string;
};

/**
 * The upstream subscriptions sessions own, such as transaction watches and statement subscriptions, each under a local
 * token of its own. Several sessions can own one upstream subscription, and it is released upstream with its last
 * owner.
 */
export function createOwnedTokens({ localTokenIds, addSessionToken, deleteSessionToken, sendRelease, log }: Params) {
  const localToOwned = new Map<string, OwnedToken>();
  const upstreamToOwned = new Map<string, Set<string>>();

  function mapToken({ sessionId, upstreamToken, releaseMethod, method }: MapTokenParams): string {
    const localToken = localTokenIds.takeNext({ prefix: 'token', sessionId });
    localToOwned.set(localToken, { sessionId, localToken, upstreamToken, releaseMethod });
    let localTokens = upstreamToOwned.get(upstreamToken);
    if (localTokens === undefined) {
      localTokens = new Set<string>();
      upstreamToOwned.set(upstreamToken, localTokens);
    }
    localTokens.add(localToken);
    addSessionToken({ sessionId, token: localToken });
    log(`Token mapped: ${localToken} to ${upstreamToken} (${method})`);
    return localToken;
  }

  function find(localToken: string): Readonly<OwnedToken> | undefined {
    return localToOwned.get(localToken);
  }

  function has(localToken: string): boolean {
    return localToOwned.has(localToken);
  }

  function listLocalTokens(upstreamToken: string): string[] {
    return [...(upstreamToOwned.get(upstreamToken) ?? [])];
  }

  function release(localToken: string, notifyUpstream: boolean): { lastOwner: boolean } | null {
    const owned = localToOwned.get(localToken);
    if (!owned) {
      return null;
    }

    localToOwned.delete(localToken);
    deleteSessionToken({ sessionId: owned.sessionId, token: localToken });

    const localTokens = upstreamToOwned.get(owned.upstreamToken);
    if (localTokens?.delete(localToken) !== true) {
      return null;
    }

    if (localTokens.size > 0) {
      return { lastOwner: false };
    }

    upstreamToOwned.delete(owned.upstreamToken);
    if (notifyUpstream) {
      sendRelease({ method: owned.releaseMethod, upstreamToken: owned.upstreamToken });
    }
    return { lastOwner: true };
  }

  function clear(): void {
    localToOwned.clear();
    upstreamToOwned.clear();
  }

  return {
    /** Maps an upstream subscription to a new local token the session owns, and returns that token. */
    mapToken,
    /** The subscription a local token names, or undefined for a token no session owns. */
    find,
    /** Whether a session still owns `localToken`. */
    has,
    /** The local tokens that own `upstreamToken`, as a copy. Empty for a token nobody owns. */
    listLocalTokens,
    /**
     * Ends `localToken`'s ownership. Returns null for a token no session owns, or else whether it was the last owner of
     * its upstream subscription. The last owner's release goes upstream only when `notifyUpstream` is set.
     */
    release,
    /** Forgets every owned subscription, sending nothing upstream. */
    clear,
  };
}
