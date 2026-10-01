// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Ends the transaction watches a chain transport loses when it disconnects.
//
// polkadot-api's proxy forgets an answered request, so a reconnect drops an
// acknowledged `transactionWatch_v1_submitAndWatch` without a word, and the
// subscription replay above it must not resubmit a transaction. The guard
// sends each such watch the spec's terminal `dropped` event instead, so its
// consumer stops waiting. A submit still unanswered at the disconnect is left
// alone: the proxy re-sends it, and the guard tracks it once it is answered.

import type { JsonRpcMessage, JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import type { ConnectionStatus } from '@dotli/resolver';

const SUBMIT_AND_WATCH = 'transactionWatch_v1_submitAndWatch';
const UNWATCH = 'transactionWatch_v1_unwatch';
const WATCH_EVENT = 'transactionWatch_v1_watchEvent';
const TERMINAL_EVENTS = new Set(['finalized', 'error', 'invalid', 'dropped']);

export interface WatchGuard {
  /** The transport, with the watches it carries tracked. */
  provider: JsonRpcProvider;
  /** The transport's status. `disconnected` ends every tracked watch. */
  onStatus: (status: ConnectionStatus) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function createWatchGuard(transport: JsonRpcProvider): WatchGuard {
  // Submit request ids not answered yet, and the watches their answers named.
  const pending = new Set<string | number>();
  const watches = new Set<string>();
  let deliver: ((message: JsonRpcMessage) => void) | null = null;

  const observe = (message: JsonRpcMessage<unknown>): void => {
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
        TERMINAL_EVENTS.has(result['event'])
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
  };

  const provider: JsonRpcProvider = onMessage => {
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
  };

  return {
    provider,
    onStatus(status) {
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
    },
  };
}
