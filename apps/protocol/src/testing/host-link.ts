// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A host page linked to this frame's transport over an in-memory pair, so specs drive the frame's handlers through the
// wire as the host does. Every issue a transport of the link raises is kept, and closing the links fails on any of
// them, so none goes unseen.

import { endListeners, protocolSchema, type ProtocolTransport, type SubscriptionEnd } from '@dotli/protocol';
import { deferred } from '@dotli/shared';
import { createProviderPair } from '@dotli/transport/testing';
import { createTransport, describeIssue, type Subscription, type TransportIssue } from '@dotli/transport';

/**
 * How a subscription whose own end reason is `I` ended: the peer's interrupt or a failure of the transport's own, as
 * the `CallError` of its end, or the error its transport closed with.
 */
export type EndOf<I> = SubscriptionEnd<I> | Error;

export type HostLink = {
  /** The frame's end, where a spec registers the handlers under test. */
  serving: ProtocolTransport;
  /** The host page's end, which opens the handshake. */
  host: ProtocolTransport;
  /** Every frame either end delivered to the other, in order. */
  delivered: readonly Uint8Array[];
  /** Disposes both ends. */
  close: () => void;
};

/** Each open link, with what either end could not handle itself, in order. */
const links = new Map<HostLink, TransportIssue[]>();

/** Links a host page to the frame. */
export function linkHost(): HostLink {
  const { left, right, delivered } = createProviderPair();
  const issues: TransportIssue[] = [];
  const onIssue = (issue: TransportIssue): void => {
    issues.push(issue);
  };
  const serving = createTransport(protocolSchema, right, {
    handshake: 'respond',
    hello: { resolutionId: null },
    onIssue,
  });
  const host = createTransport(protocolSchema, left, {
    handshake: 'offer',
    hello: { resolutionId: null },
    onIssue,
  });
  host.connect();
  const link: HostLink = {
    serving,
    host,
    delivered,
    close: () => {
      links.delete(link);
      const over = new Error('The spec is over');
      host.dispose(over);
      serving.dispose(over);
    },
  };
  links.set(link, issues);
  return link;
}

/** Closes every link a spec left open, and throws when a link raised an issue. */
export function closeHostLinks(): void {
  const unseen = [...links.values()].flat();
  for (const link of [...links.keys()]) {
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
  const answer = await link.host.request(protocolSchema.sections.frame.warmup, undefined);
  if (answer.success || answer.value.tag !== 'Unsupported') {
    throw new Error('The frame served the warmup, so the round trip proves nothing');
  }
}

export type Recording<V, I> = {
  events: V[];
  /** Settles with the end: the frame's interrupt, or the error the transport closed with. */
  ended: Promise<EndOf<I>>;
  /** Resolves once `count` events have arrived. */
  until: (count: number) => Promise<void>;
  unsubscribe: () => void;
};

/** Subscribes on `transport` and records every value and the end. */
export function record<S, V, I>(
  transport: ProtocolTransport,
  method: Subscription<S, V, SubscriptionEnd<I>>,
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
    ...endListeners<I>(ended.resolve),
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
