// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Ends the transaction watches a transport loses on disconnect. polkadot-api's proxy forgets an
// answered submit, so a reconnect silently drops the watch and the replay must not resubmit. Each such
// watch gets a terminal `dropped` event instead. Unanswered submits are left to the proxy's resend.

import type { JsonRpcConnection, JsonRpcMessage, JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { isRecord } from '@dotli/shared';
import { SUBMIT_AND_WATCH, TERMINAL_WATCH_EVENTS, UNWATCH, WATCH_EVENT } from './jsonRpcMethods.js';
import type { ConnectionStatus } from './transportHooks.js';

/** A transport that tracks its transaction watches, and ends them when it disconnects. */
export type WatchGuard = ReturnType<typeof createWatchGuard>;

type Params = {
  /** The transport whose transaction watches are tracked. */
  transport: JsonRpcProvider;
};

/** Wraps `transport` so each answered transaction watch hears one `dropped` event when the transport disconnects. */
export function createWatchGuard({ transport }: Params) {
  // Submit request ids not answered yet, and the watches their answers named.
  const pending = new Set<string | number>();
  const watches = new Set<string>();
  let deliver: ((message: JsonRpcMessage) => void) | null = null;

  function observe(message: JsonRpcMessage<unknown>): void {
    if ('method' in message) {
      if (message.method !== WATCH_EVENT || !isRecord(message.params)) {
        return;
      }
      const subscription = message.params['subscription'];
      const result = message.params['result'];
      if (
        typeof subscription === 'string' &&
        isRecord(result) &&
        typeof result['event'] === 'string' &&
        TERMINAL_WATCH_EVENTS.has(result['event'])
      ) {
        watches.delete(subscription);
      }
      return;
    }
    if (message.id === null || !pending.delete(message.id)) {
      return;
    }
    if ('result' in message && typeof message.result === 'string') {
      watches.add(message.result);
    }
  }

  function provider(onMessage: (message: JsonRpcMessage) => void): JsonRpcConnection {
    deliver = onMessage;
    const connection = transport(message => {
      observe(message);
      onMessage(message);
    });
    return {
      send(message) {
        if (message.method === SUBMIT_AND_WATCH && message.id !== undefined && message.id !== null) {
          pending.add(message.id);
        } else if (message.method === UNWATCH) {
          const params: unknown = message.params;
          if (Array.isArray(params) && typeof params[0] === 'string') {
            watches.delete(params[0]);
          }
        }
        connection.send(message);
      },
      disconnect() {
        deliver = null;
        pending.clear();
        watches.clear();
        connection.disconnect();
      },
    };
  }

  function onStatus(status: ConnectionStatus): void {
    const target = deliver;
    if (status !== 'disconnected' || target === null) {
      return;
    }
    const ended = [...watches];
    watches.clear();
    for (const subscription of ended) {
      target({
        jsonrpc: '2.0',
        method: WATCH_EVENT,
        params: { subscription, result: { event: 'dropped' } },
      });
    }
  }

  return {
    /** The transport, with the watches it carries tracked. */
    provider,
    /** `disconnected` ends every tracked watch. */
    onStatus,
  };
}
