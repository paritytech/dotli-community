// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { isRecord } from '@dotli/shared';
import {
  buildFollowEvent,
  buildJsonRpcResult,
  getEventType,
  readdressSubscription,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type SendReleaseParams,
  type Session,
  type SessionTokenParams,
  type SharedFollow,
  type SubscriptionMessage,
} from './brokerMessages.js';
import { createChainHaltedError } from './createChainHaltedError.js';
import type { EarlySubscriptions } from './createEarlySubscriptions.js';
import { createFollowSnapshot } from './createFollowSnapshot.js';
import { createJsonRpcError } from './createJsonRpcError.js';
import type { LocalTokenIds } from './createLocalTokenIds.js';
import type { PendingRequests } from './createPendingRequests.js';
import { CHAIN_HEAD_UNFOLLOW, CHAIN_HEAD_UNPIN } from './jsonRpcMethods.js';

/** A session as the follows read it. Its token set changes only through `addSessionToken` and `deleteSessionToken`. */
type SessionView = Readonly<Omit<Session, 'ownedTokens'>>;

type Params = {
  /** Numbers the local token each session gets on a follow. */
  localTokenIds: LocalTokenIds;
  /** Sends the one upstream follow a new shared follow asks for. */
  pending: Pick<PendingRequests, 'track'>;
  /** Holds the events that come before a follow's answer. */
  earlySubscriptions: Pick<EarlySubscriptions, 'flush' | 'drop'>;
  /** The open session `sessionId` names, or undefined once it has gone. */
  getSession: (sessionId: string) => SessionView | undefined;
  /** Adds a token to its session's set. Does nothing for a session that has gone. */
  addSessionToken: (params: SessionTokenParams) => void;
  /** Drops a token from its session's set. Does nothing for a session that has gone. */
  deleteSessionToken: (params: SessionTokenParams) => void;
  /** Delivers a message to a session, encoded for its wire mode. */
  sendToSession: (session: SessionView, message: unknown) => void;
  /** Sends a release upstream that no session waits on. */
  sendRelease: (params: SendReleaseParams) => void;
  /** Logs broker traffic at debug level. */
  log: (message: string) => void;
};

type LocalFollow = {
  /** The session that holds the token. */
  sessionId: string;
  /** The upstream token of its follow, or null while the follow waits on its answer or has gone. */
  upstreamToken: string | null;
};

type UnpinParams = {
  /** A session's token on a follow. */
  localToken: string;
  /** The blocks the session unpins. */
  hashes: readonly string[];
};

type HandleEventParams = {
  /** The follow's upstream token. */
  upstreamToken: string;
  /** The upstream's follow event. */
  message: SubscriptionMessage;
};

type StopSharedFollowParams = {
  /** The follow the upstream stopped. */
  sharedFollow: SharedFollow;
  /** Its upstream token. */
  upstreamToken: string;
  /** The upstream's `stop` event, told to each session under its own token. */
  message: SubscriptionMessage;
};

type ReplayFollowSnapshotParams = {
  /** The session that joined a follow the upstream already answered. */
  session: SessionView;
  /** The session's new token on that follow. */
  localToken: string;
  /** The follow whose pinned blocks the session is told about. */
  sharedFollow: SharedFollow;
};

/**
 * The chainHead follows sessions share. Sessions that follow with the same params share one upstream follow, each
 * under a local token of its own, and a block is unpinned upstream only once no session and no snapshot holds it.
 */
export function createSharedFollows({
  localTokenIds,
  pending,
  earlySubscriptions,
  getSession,
  addSessionToken,
  deleteSessionToken,
  sendToSession,
  sendRelease,
  log,
}: Params) {
  const sharedFollows = new Map<string, SharedFollow>();
  const upstreamFollowTokens = new Map<string, SharedFollow>();
  const localFollowTokens = new Map<string, { sessionId: string; followKey: string }>();

  function follow(session: SessionView, request: JsonRpcRequest): void {
    const followKey = JSON.stringify(request.params ?? []);
    const existing = sharedFollows.get(followKey);
    const sharedFollow: SharedFollow = existing ?? {
      key: followKey,
      upstreamToken: null,
      localTokens: new Set<string>(),
      pendingLocals: [],
      snapshot: createFollowSnapshot(),
    };
    if (existing === undefined) {
      sharedFollows.set(followKey, sharedFollow);
    }

    const localToken = localTokenIds.takeNext({ prefix: 'follow', sessionId: session.id });
    localFollowTokens.set(localToken, { sessionId: session.id, followKey });
    addSessionToken({ sessionId: session.id, token: localToken });
    sharedFollow.localTokens.add(localToken);

    if (sharedFollow.upstreamToken !== null) {
      if (request.id !== undefined) {
        sendToSession(session, buildJsonRpcResult(request.id ?? null, localToken));
      }
      // A session that unfollowed or left inside that answer would be pinned blocks it can never unpin.
      if (!localFollowTokens.has(localToken)) {
        return;
      }
      replayFollowSnapshot({ session, localToken, sharedFollow });
      return;
    }

    sharedFollow.pendingLocals.push({ sessionId: session.id, requestId: request.id ?? null, localToken });
    // Asked for once, as it is created. Until the answer, every later session waits on that one request.
    if (existing === undefined) {
      pending.track({ owner: { kind: 'follow', follow: sharedFollow }, request });
    }
  }

  function findLocalFollow(localToken: string): LocalFollow | undefined {
    const followToken = localFollowTokens.get(localToken);
    if (followToken === undefined) {
      return undefined;
    }
    return {
      sessionId: followToken.sessionId,
      upstreamToken: sharedFollows.get(followToken.followKey)?.upstreamToken ?? null,
    };
  }

  function unpin({ localToken, hashes }: UnpinParams): boolean {
    const sharedFollow = findSharedFollow(localToken);
    if (sharedFollow?.upstreamToken === undefined || sharedFollow.upstreamToken === null) {
      return false;
    }
    const orphaned = sharedFollow.snapshot.release(localToken, hashes);
    if (orphaned.length > 0) {
      sendRelease({ method: CHAIN_HEAD_UNPIN, upstreamToken: sharedFollow.upstreamToken, params: [orphaned] });
    }
    return true;
  }

  function release(localToken: string): void {
    const followToken = localFollowTokens.get(localToken);
    if (!followToken) {
      return;
    }

    localFollowTokens.delete(localToken);
    deleteSessionToken({ sessionId: followToken.sessionId, token: localToken });

    const sharedFollow = sharedFollows.get(followToken.followKey);
    if (!sharedFollow) {
      return;
    }

    sharedFollow.localTokens.delete(localToken);
    sharedFollow.pendingLocals = sharedFollow.pendingLocals.filter(
      pendingLocal => pendingLocal.localToken !== localToken,
    );

    const upstreamToken = sharedFollow.upstreamToken;
    const orphaned = sharedFollow.snapshot.release(localToken, null);
    // Not answered yet, so it stays for the sessions that join before its answer.
    if (upstreamToken === null) {
      return;
    }
    // A live follow unpins orphaned blocks upstream. For the last token the unfollow below releases them all.
    if (sharedFollow.localTokens.size > 0) {
      if (orphaned.length > 0) {
        sendRelease({ method: CHAIN_HEAD_UNPIN, upstreamToken, params: [orphaned] });
      }
      return;
    }
    dropSharedFollow(sharedFollow);
    sendRelease({ method: CHAIN_HEAD_UNFOLLOW, upstreamToken });
  }

  function releaseSession(sessionId: string): void {
    for (const [localToken, followToken] of [...localFollowTokens.entries()]) {
      if (followToken.sessionId === sessionId) {
        release(localToken);
      }
    }
  }

  function answer(sharedFollow: SharedFollow, response: JsonRpcResponse): void {
    if (typeof response.result !== 'string') {
      failFollow(sharedFollow, response);
      return;
    }
    const upstreamToken = response.result;
    // Every session left while the follow was in flight, and nobody else would ever end it.
    if (sharedFollow.localTokens.size === 0) {
      dropSharedFollow(sharedFollow);
      earlySubscriptions.drop(upstreamToken);
      sendRelease({ method: CHAIN_HEAD_UNFOLLOW, upstreamToken });
      return;
    }
    sharedFollow.upstreamToken = upstreamToken;
    upstreamFollowTokens.set(upstreamToken, sharedFollow);
    for (const pendingLocal of sharedFollow.pendingLocals.splice(0)) {
      const pendingSession = getSession(pendingLocal.sessionId);
      if (pendingSession?.connected !== true) {
        continue;
      }
      sendToSession(pendingSession, buildJsonRpcResult(pendingLocal.requestId, pendingLocal.localToken));
    }
    earlySubscriptions.flush(upstreamToken);
  }

  function hasUpstreamToken(upstreamToken: string): boolean {
    return upstreamFollowTokens.has(upstreamToken);
  }

  function handleEvent({ upstreamToken, message }: HandleEventParams): void {
    const sharedFollow = upstreamFollowTokens.get(upstreamToken);
    if (!sharedFollow) {
      return;
    }
    const eventResult = message.params?.result;
    if (isRecord(eventResult) && eventResult['event'] === 'stop') {
      stopSharedFollow({ sharedFollow, upstreamToken, message });
      return;
    }
    const orphaned = sharedFollow.snapshot.record(eventResult);
    if (orphaned.length > 0) {
      sendRelease({ method: CHAIN_HEAD_UNPIN, upstreamToken, params: [orphaned] });
    }
    // Every session holds the event's blocks before any hears it. A session that unpins inside its own delivery, as
    // polkadot-api does on `initialized`, would otherwise release them upstream under a session not yet told.
    const recipients: { session: SessionView; localToken: string }[] = [];
    for (const localToken of sharedFollow.localTokens) {
      const session = getSession(localFollowTokens.get(localToken)?.sessionId ?? '');
      if (session?.connected === true) {
        sharedFollow.snapshot.pinEvent(localToken, eventResult);
        recipients.push({ session, localToken });
      }
    }
    const eventType = getEventType(eventResult);
    for (const { session, localToken } of recipients) {
      // An earlier delivery can end this follow or session.
      if (!session.connected || !sharedFollow.localTokens.has(localToken)) {
        continue;
      }
      log(`subscription to [${session.id}] event=${eventType} method=${String(message.method)}`);
      sendToSession(session, readdressSubscription(message, localToken));
    }
  }

  function haltSession(session: SessionView): void {
    for (const sharedFollow of sharedFollows.values()) {
      for (const pendingLocal of sharedFollow.pendingLocals) {
        if (pendingLocal.sessionId === session.id && pendingLocal.requestId !== null) {
          sendToSession(session, createJsonRpcError(pendingLocal.requestId, createChainHaltedError()));
        }
      }
    }
    for (const [localToken, followToken] of localFollowTokens) {
      if (followToken.sessionId !== session.id) {
        continue;
      }
      if ((sharedFollows.get(followToken.followKey)?.upstreamToken ?? null) === null) {
        continue;
      }
      sendToSession(session, buildFollowEvent(localToken, { event: 'stop' }));
    }
  }

  function clear(): void {
    localFollowTokens.clear();
    sharedFollows.clear();
    upstreamFollowTokens.clear();
  }

  function findSharedFollow(localToken: string): SharedFollow | undefined {
    const followToken = localFollowTokens.get(localToken);
    return followToken === undefined ? undefined : sharedFollows.get(followToken.followKey);
  }

  /**
   * The upstream refused the follow or answered it without a token. It is dropped before any session hears the
   * refusal, so a session that follows again from inside its delivery, as papi does, asks the upstream afresh instead
   * of waiting on the refused one.
   */
  function failFollow(sharedFollow: SharedFollow, response: JsonRpcResponse): void {
    dropSharedFollow(sharedFollow);
    const error =
      'error' in response ? response.error : createJsonRpcError(null, 'Invalid chainHead_v1_follow answer').error;
    for (const localToken of sharedFollow.localTokens) {
      const followToken = localFollowTokens.get(localToken);
      localFollowTokens.delete(localToken);
      if (followToken !== undefined) {
        deleteSessionToken({ sessionId: followToken.sessionId, token: localToken });
      }
    }
    sharedFollow.localTokens.clear();
    for (const pendingLocal of sharedFollow.pendingLocals.splice(0)) {
      const session = getSession(pendingLocal.sessionId);
      if (session?.connected === true && pendingLocal.requestId !== null) {
        sendToSession(session, { jsonrpc: '2.0', id: pendingLocal.requestId, error });
      }
    }
  }

  /**
   * Forgets `sharedFollow` and its upstream token, unless a newer follow on the same key replaced it already. The token
   * and its reverse map entry are cleared together.
   */
  function dropSharedFollow(sharedFollow: SharedFollow): void {
    if (sharedFollows.get(sharedFollow.key) === sharedFollow) {
      sharedFollows.delete(sharedFollow.key);
    }
    if (sharedFollow.upstreamToken !== null) {
      if (upstreamFollowTokens.get(sharedFollow.upstreamToken) === sharedFollow) {
        upstreamFollowTokens.delete(sharedFollow.upstreamToken);
      }
      sharedFollow.upstreamToken = null;
    }
  }

  /**
   * Drops the follow and releases its tokens before any session hears the `stop`. papi re-follows
   * inside that delivery, and bound to the dead follow it would be stopped again without end.
   */
  function stopSharedFollow({ sharedFollow, upstreamToken, message }: StopSharedFollowParams): void {
    log(
      `Shared follow stopped by upstream; clearing for re-follow: key=${sharedFollow.key} token=${upstreamToken.slice(0, 12)}…`,
    );
    dropSharedFollow(sharedFollow);
    const recipients: { session: SessionView; localToken: string }[] = [];
    for (const localToken of sharedFollow.localTokens) {
      const session = getSession(localFollowTokens.get(localToken)?.sessionId ?? '');
      // The shared follow is gone, so nothing goes upstream for a follow the node already ended.
      release(localToken);
      if (session?.connected === true) {
        recipients.push({ session, localToken });
      }
    }
    for (const { session, localToken } of recipients) {
      log(`subscription to [${session.id}] event=stop method=${String(message.method)}`);
      sendToSession(session, readdressSubscription(message, localToken));
    }
  }

  function replayFollowSnapshot({ session, localToken, sharedFollow }: ReplayFollowSnapshotParams): void {
    for (const result of sharedFollow.snapshot.replayFor(localToken)) {
      sendToSession(session, buildFollowEvent(localToken, result));
    }
  }

  return {
    /**
     * Joins `session` to the shared follow its request's params name, opening it upstream when none is open. The
     * session is answered with its local token once the upstream has answered, and then replayed the follow's
     * snapshot.
     */
    follow,
    /** The session and upstream token behind a session's local follow token, or undefined for another token. */
    findLocalFollow,
    /**
     * Unpins blocks for a session's follow token, unpinning upstream those no one holds anymore, and returns true.
     * Returns false and does nothing for a token whose follow has no upstream token.
     */
    unpin,
    /**
     * Releases a session's follow token, unpinning upstream the blocks only it held, and unfollowing upstream with the
     * follow's last token. Does nothing for an unknown token.
     */
    release,
    /** Releases every follow token of session `sessionId`. */
    releaseSession,
    /**
     * Takes the upstream's answer to a shared follow. A token answers every session waiting on it, anything else
     * fails each of them, and a follow every session left meanwhile is unfollowed at once.
     */
    answer,
    /** Whether `upstreamToken` names a shared follow the upstream answered. */
    hasUpstreamToken,
    /**
     * Tells every session on a follow one upstream event, each under its own token. A `stop` drops the follow and
     * releases its tokens before any session hears it.
     */
    handleEvent,
    /**
     * Answers a halted session: an error for each follow it waits on, and a `stop` for each answered follow it holds.
     */
    haltSession,
    /** Forgets every follow, sending nothing upstream. */
    clear,
  };
}
