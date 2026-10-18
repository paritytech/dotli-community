// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A subscription to the frame as the host's layers hold it. Whether the frame ended it or the transport closed under
// it, its one end is heard in one place, as the error host code sees.

import { reportListener } from '@dotli/metrics';
import type { Subscription as Method } from '@dotli/transport';
import { callName } from './call-names.js';
import { callFailure, fromTransportError } from './outcomes.js';
import type { DomainFailure, ProtocolTransport } from './schema.js';

export interface Subscription {
  /** Ends the subscription without calling its end listeners, and tells the frame. */
  unsubscribe(): void;
  /** Hears the one end: null when the frame ended it cleanly, else why it ended. Called at once if it has. */
  onEnd(listener: (error: Error | null) => void): void;
}

export interface SubscribeOptions {
  /** Gives up on the subscription, which ends with the signal's reason and tells the frame. */
  signal?: AbortSignal;
}

const report = reportListener('protocol', 'protocol.transport');

/** Runs one end listener, so one that throws is reported and the others still hear the end. */
function heard(listener: (error: Error | null) => void, error: Error | null): void {
  try {
    listener(error);
  } catch (thrown) {
    report(thrown);
  }
}

/** Subscribes `method` on `transport`, and hears each value with `receive`. Throws when `start` is refused. */
export function subscribe<S, V, I extends DomainFailure>(
  transport: ProtocolTransport,
  method: Method<S, V, I>,
  start: NoInfer<S>,
  receive: (value: V) => void,
  options: SubscribeOptions = {},
): Subscription {
  const name = callName(method);
  const { signal } = options;
  let state: { name: 'open' | 'unsubscribed' } | { name: 'ended'; error: Error | null } = { name: 'open' };
  const listeners: ((error: Error | null) => void)[] = [];
  const end = (error: Error | null): void => {
    if (state.name !== 'open') {
      return;
    }
    state = { name: 'ended', error };
    for (const listener of listeners.splice(0)) {
      heard(listener, error);
    }
  };
  const handle = transport.subscribe(
    method,
    start,
    {
      receive,
      interrupt: outcome => {
        end(outcome.tag === 'Ok' ? null : callFailure(outcome.value, name, signal));
      },
    },
    signal === undefined ? {} : { signal },
  );
  handle.onClose(error => {
    end(fromTransportError(error));
  });
  return {
    unsubscribe() {
      if (state.name !== 'open') {
        return;
      }
      state = { name: 'unsubscribed' };
      listeners.length = 0;
      handle.stop();
    },
    onEnd(listener) {
      if (state.name === 'ended') {
        heard(listener, state.error);
      } else if (state.name === 'open') {
        listeners.push(listener);
      }
    },
  };
}
