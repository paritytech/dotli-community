// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEndListeners, type ProtocolTransport, type SubscriptionEnd } from '@dotli/protocol';
import { createDeferred } from '@dotli/shared';
import type { Subscription } from '@dotli/transport';

import { createWaitList } from './createWaitList.js';

/**
 * How a subscription whose own end reason is `Domain` ended: the peer's interrupt or a failure of the transport's own,
 * as the `CallError` of its end, or the error its transport closed with.
 */
export type EndOf<Domain> = SubscriptionEnd<Domain> | Error;

/** A subscription's values and end, as they arrive. */
export type Recording<Value, Domain> = ReturnType<typeof record<unknown, Value, Domain>>;

type Params<Start, Value, Domain> = {
  /** The transport the subscription is made on. */
  transport: ProtocolTransport;
  /** The method subscribed to. */
  method: Subscription<Start, Value, SubscriptionEnd<Domain>>;
  /** The subscription's start. */
  start: NoInfer<Start>;
};

/** Subscribes on `transport` and records every value and the end. */
export function record<Start, Value, Domain>({ transport, method, start }: Params<Start, Value, Domain>) {
  const events: Value[] = [];
  const waits = createWaitList();
  const ended = createDeferred<EndOf<Domain>>();
  const unsubscribe = transport.subscribe({
    method,
    start,
    listeners: {
      receive(value) {
        events.push(value);
        waits.check();
      },
      ...createEndListeners<Domain>(ended.resolve),
      close: ended.resolve,
    },
  });
  return {
    /** Every value, in order. */
    events,
    /** Settles with the end: the frame's interrupt, or the error the transport closed with. */
    ended: ended.promise,
    /** Resolves once `count` events have arrived. Never rejects. */
    waitFor: (count: number): Promise<void> => waits.waitFor(() => events.length >= count),
    /** Stops the subscription. Never throws. */
    unsubscribe,
  };
}
