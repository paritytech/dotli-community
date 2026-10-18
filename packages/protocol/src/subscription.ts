// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A subscription to the frame as the host's layers hold it. Whether the frame ended it or the transport closed under
// it, its one end is heard in one place, as the error host code sees.

import type { SubscribeOptions, Subscription as Method } from '@dotli/transport';
import { callName } from './call-names.js';
import { callFailure, fromTransportError } from './outcomes.js';
import type { DomainFailure, ProtocolTransport } from './schema.js';

/** What a subscriber hears: each value, then one end, unless it stops first. */
export interface SubscriptionListeners<V> {
  receive(value: V): void;
  /** Null when the frame ended it cleanly, else why it ended, as the error host code sees. */
  end(error: Error | null): void;
}

/** Subscribes `method` on `transport`, and returns what stops it. Throws when `start` is refused. */
export function subscribe<S, V, I extends DomainFailure>(
  transport: ProtocolTransport,
  method: Method<S, V, I>,
  start: NoInfer<S>,
  listeners: SubscriptionListeners<NoInfer<V>>,
  options: SubscribeOptions = {},
): () => void {
  const name = callName(method);
  return transport.subscribe(
    method,
    start,
    {
      receive: value => {
        listeners.receive(value);
      },
      interrupt: outcome => {
        listeners.end(outcome.success ? null : callFailure(outcome.value, name, options.signal));
      },
      close: error => {
        listeners.end(fromTransportError(error));
      },
    },
    options,
  );
}
