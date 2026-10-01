// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A reconnect cannot safely replay an acknowledged transaction submission.
// End modern and legacy watches when their transport disconnects; pending
// submissions remain with the provider proxy until answered.
import type { JsonRpcMessage, JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import type { ConnectionStatus } from '@dotli/resolver';

const SUBMIT_AND_WATCH = 'transactionWatch_v1_submitAndWatch';
const UNWATCH = 'transactionWatch_v1_unwatch';
const WATCH_EVENT = 'transactionWatch_v1_watchEvent';
const LEGACY_SUBMIT = 'author_submitAndWatchExtrinsic';
const LEGACY_UNWATCH = 'author_unwatchExtrinsic';
const LEGACY_EVENT = 'author_extrinsicUpdate';
const TERMINAL_EVENTS = new Set(['finalized', 'error', 'invalid', 'dropped']);
const LEGACY_TERMINAL_EVENTS: Record<string, true> = {
  finalized: true,
  invalid: true,
  dropped: true,
  usurped: true,
  finalityTimeout: true,
};

export interface WatchGuard {
  provider: JsonRpcProvider;
  onStatus: (status: ConnectionStatus) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function createWatchGuard(transport: JsonRpcProvider): WatchGuard {
  const pending = new Map<string | number, boolean>();
  const watches = new Map<string, boolean>();
  let deliver: ((message: JsonRpcMessage) => void) | null = null;

  const observe = (message: JsonRpcMessage<unknown>): void => {
    if ('method' in message) {
      if (!isRecord(message.params)) {
        return;
      }
      const subscription = message.params['subscription'];
      const result = message.params['result'];
      if (typeof subscription !== 'string') {
        return;
      }
      if (
        message.method === WATCH_EVENT &&
        isRecord(result) &&
        typeof result['event'] === 'string' &&
        TERMINAL_EVENTS.has(result['event'])
      ) {
        watches.delete(subscription);
      } else if (message.method === LEGACY_EVENT) {
        const kind = typeof result === 'string' ? result : isRecord(result) ? Object.keys(result)[0] : undefined;
        if (kind !== undefined && LEGACY_TERMINAL_EVENTS[kind] === true) {
          watches.delete(subscription);
        }
      }
      return;
    }
    if (message.id === null) {
      return;
    }
    const legacy = pending.get(message.id);
    if (legacy === undefined) {
      return;
    }
    pending.delete(message.id);
    if ('result' in message && typeof message.result === 'string') {
      watches.set(message.result, legacy);
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
        if (
          (message.method === SUBMIT_AND_WATCH || message.method === LEGACY_SUBMIT) &&
          message.id !== undefined &&
          message.id !== null
        ) {
          pending.set(message.id, message.method === LEGACY_SUBMIT);
        } else if (message.method === UNWATCH || message.method === LEGACY_UNWATCH) {
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
      for (const [subscription, legacy] of ended) {
        target({
          jsonrpc: '2.0',
          method: legacy ? LEGACY_EVENT : WATCH_EVENT,
          params: { subscription, result: legacy ? 'dropped' : { event: 'dropped' } },
        });
      }
    },
  };
}
