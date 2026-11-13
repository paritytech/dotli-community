// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  RELEASE_METHODS,
  TOKEN_METHODS,
  type JsonRpcRequest,
  type RequestOwner,
  type Session,
} from './brokerMessages.js';

type Params = {
  /** Posts a message upstream. */
  sendUpstream: (message: unknown) => void;
};

type TrackParams = {
  /** Who the answer goes to. */
  owner: RequestOwner;
  /** The request, sent under a fresh broker id in place of its own. */
  request: JsonRpcRequest;
};

/** The requests the broker sent upstream and the owner of each, by the broker id they went out under. */
export function createPendingRequests({ sendUpstream }: Params) {
  const pending = new Map<string, RequestOwner>();
  let requestCounter = 0;

  function track({ owner, request }: TrackParams): void {
    const upstreamId = `broker:${requestCounter.toString(36)}`;
    requestCounter += 1;
    pending.set(upstreamId, owner);
    sendUpstream({ ...request, id: upstreamId });
  }

  function take(id: string): RequestOwner | undefined {
    const owner = pending.get(id);
    pending.delete(id);
    return owner;
  }

  function has(id: string): boolean {
    return pending.has(id);
  }

  function listOwners(): IterableIterator<Readonly<RequestOwner>> {
    return pending.values();
  }

  function count(): number {
    return pending.size;
  }

  function isReleasing(upstreamToken: string): boolean {
    return [...pending.values()].some(
      owner => owner.upstreamToken === upstreamToken && (owner.kind === 'release' || RELEASE_METHODS.has(owner.method)),
    );
  }

  function hasSubscriptionRequest(): boolean {
    return [...pending.values()].some(owner => TOKEN_METHODS.has(owner.method));
  }

  function orphanSession(session: Session): void {
    for (const [requestId, owner] of pending) {
      if (owner.kind === 'session' && owner.session === session) {
        pending.set(requestId, { kind: 'orphan', method: owner.method, upstreamToken: owner.upstreamToken });
      }
    }
  }

  function clear(): void {
    pending.clear();
  }

  return {
    /** Sends `request` upstream under a fresh broker id, owned by `owner` until its answer arrives. */
    track,
    /** Removes the request answered under broker id `id`, and returns its owner, or undefined for an unknown id. */
    take,
    /** Whether broker id `id` names a request still in flight. */
    has,
    /** The owners of the requests in flight, live, so a request tracked while it is read is read too. */
    listOwners,
    /** How many requests are in flight. */
    count,
    /** Whether a release of `upstreamToken` is in flight, so the node may still send events it queued for it. */
    isReleasing,
    /** Whether a request in flight may open a subscription, whose events can come before its answer. */
    hasSubscriptionRequest,
    /** Hands each request of `session` to an orphan owner, as the session has gone. */
    orphanSession,
    /** Forgets every request in flight. Their broker ids are never reused. */
    clear,
  };
}
