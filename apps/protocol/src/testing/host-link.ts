// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A host page linked to this frame's transport over an in-memory pair, so specs drive the frame's handlers through the
// wire as the host does. Every issue a transport of the link raises is kept, and closing the links fails on any issue a
// spec did not take, so none goes unseen.

import { protocolSchema, type ProtocolTransport } from '@dotli/protocol';
import { deferred } from '@dotli/shared';
import { createProviderPair } from '@dotli/transport/testing';
import {
  createTransport,
  describeIssue,
  type CallError,
  type ResultPayload,
  type Subscription,
  type TransportIssue,
} from '@dotli/transport';

export const HOST_ORIGIN = 'http://host-playground.localhost:5173';
export const PRODUCT_ORIGIN = 'http://bafy.app.localhost:5173';

/** How a subscription whose own end reason is `I` ended: the peer's interrupt, or the error its transport closed with. */
export type EndOf<I> = ResultPayload<undefined, CallError<I>> | Error;

export interface HostLink {
  /** The frame's end, where a spec registers the handlers under test. */
  serving: ProtocolTransport;
  /** The host page's end, which opens the handshake. */
  host: ProtocolTransport;
  /**
   * What either end, or a transport the spec handed `report`, could not handle itself, in order. A spec that expects an
   * issue takes it from here, and any left fails the spec as its links close.
   */
  issues: TransportIssue[];
  /** The issue hook of the link, for another transport of the spec. */
  report: (issue: TransportIssue) => void;
  /** Disposes both ends. */
  close: () => void;
}

const links = new Set<HostLink>();

/** Links a host page known by `origin`, which the frame's provider names, as the window provider names the parent's. */
export function linkHost(origin: string | null = HOST_ORIGIN): HostLink {
  const { left, right } = createProviderPair();
  const issues: TransportIssue[] = [];
  const onIssue = (issue: TransportIssue): void => {
    issues.push(issue);
  };
  const serving = createTransport(
    protocolSchema,
    { ...right, peerOrigin: () => origin },
    { handshake: 'accept', hello: { resolutionId: null }, onIssue },
  );
  const host = createTransport(protocolSchema, left, {
    handshake: 'open',
    hello: { resolutionId: null },
    onIssue,
  });
  host.connect();
  const link: HostLink = {
    serving,
    host,
    issues,
    report: onIssue,
    close: () => {
      links.delete(link);
      const over = new Error('The spec is over');
      host.dispose(over);
      serving.dispose(over);
    },
  };
  links.add(link);
  return link;
}

/** Closes every link a spec left open, and throws when a link kept an issue the spec did not take. */
export function closeHostLinks(): void {
  const unseen = [...links].flatMap(link => link.issues.splice(0));
  for (const link of [...links]) {
    link.close();
  }
  if (unseen.length > 0) {
    throw new Error(`The links raised issues the spec did not expect: ${unseen.map(describeIssue).join(' | ')}`, {
      cause: unseen,
    });
  }
}

/** Settles once the frame has answered a call made after everything before it, by asking for a method it lacks. */
export async function roundTrip(link: HostLink): Promise<void> {
  const answer = await link.host.request(protocolSchema.traits.frame.warmup, undefined);
  if (answer.success || answer.value.tag !== 'Unsupported') {
    throw new Error('The frame served the warmup, so the round trip proves nothing');
  }
}

export interface Recording<V, I> {
  events: V[];
  /** Settles with the end: the frame's interrupt, or the error the transport closed with. */
  ended: Promise<EndOf<I>>;
  /** Resolves once `count` events have arrived. */
  until: (count: number) => Promise<void>;
  unsubscribe: () => void;
}

/** Subscribes on `transport` and records every value and the end. */
export function record<S, V, I>(
  transport: ProtocolTransport,
  method: Subscription<S, V, I>,
  start: NoInfer<S>,
): Recording<V, I> {
  const events: V[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  const ended = deferred<EndOf<I>>();
  const unsubscribe = transport.subscribe(method, start, {
    receive: value => {
      events.push(value);
      for (const waiter of [...waiters]) {
        if (events.length >= waiter.count) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
    },
    interrupt: ended.resolve,
    close: ended.resolve,
  });
  return {
    events,
    ended: ended.promise,
    until: count =>
      events.length >= count
        ? Promise.resolve()
        : new Promise(resolve => {
            waiters.push({ count, resolve });
          }),
    unsubscribe,
  };
}
