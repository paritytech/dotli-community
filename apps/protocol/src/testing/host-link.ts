// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A host page linked to this frame's serving transport over a real port pair, so specs drive the frame's handlers
// through the wire as the host does.

import {
  createConsumerTransport,
  createPortProvider,
  createServingTransport,
  type ConsumerTransport,
  type ServingTransport,
  type SubscribePayload,
  type SubscriptionEvent,
  type SubscriptionMethod,
} from '@dotli/protocol';

export const HOST_ORIGIN = 'http://host-playground.localhost:5173';
export const PRODUCT_ORIGIN = 'http://bafy.app.localhost:5173';

export interface HostLink {
  /** The frame's end, where a spec registers the handlers under test. */
  serving: ServingTransport;
  /** The host page's end, connected. */
  host: ConsumerTransport;
  /** Disposes both ends and closes the ports. */
  close: () => void;
}

const links = new Set<HostLink>();

/**
 * Links a host page known by `origin`. A port has no origin, so the frame's provider names it, as the window provider
 * names the admitted parent's.
 */
export function linkHost(origin: string | null = HOST_ORIGIN): HostLink {
  const channel = new MessageChannel();
  const frameEnd = createPortProvider(channel.port1);
  const serving = createServingTransport({ ...frameEnd, peerOrigin: () => origin }, { side: 'frame', count: () => 0 });
  const host = createConsumerTransport(createPortProvider(channel.port2), { side: 'host', count: () => 0 });
  host.connect();
  const link: HostLink = {
    serving,
    host,
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

/** Closes every link a spec left open, so no port keeps the test run alive. */
export function closeHostLinks(): void {
  for (const link of [...links]) {
    link.close();
  }
}

export interface Recording<M extends SubscriptionMethod> {
  events: SubscriptionEvent<M>[];
  /** Settles with the end: null when the frame ended it cleanly, else why. */
  ended: Promise<Error | null>;
  /** Resolves once `count` events have arrived. */
  until: (count: number) => Promise<void>;
  unsubscribe: () => void;
}

/** Subscribes on the host's end and records every event and the end. */
export function record<M extends SubscriptionMethod>(
  host: ConsumerTransport,
  method: M,
  payload: SubscribePayload<M>,
  options?: { deadlineMs?: number },
): Recording<M> {
  const events: SubscriptionEvent<M>[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  const subscription = host.subscribe(
    method,
    payload,
    event => {
      events.push(event);
      for (const waiter of [...waiters]) {
        if (events.length >= waiter.count) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
    },
    options,
  );
  const ended = new Promise<Error | null>(resolve => {
    subscription.onEnd(resolve);
  });
  return {
    events,
    ended,
    until: count =>
      events.length >= count
        ? Promise.resolve()
        : new Promise(resolve => {
            waiters.push({ count, resolve });
          }),
    unsubscribe: () => {
      subscription.unsubscribe();
    },
  };
}
