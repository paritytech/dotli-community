// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Same contract as the unexported pause controller in `@novasamatech/host-substrate-chain-connection`
// (Apache-2.0). Pause closes the socket and halts so the proxy re-follows, resume reconnects and flushes.
import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import type { InnerJsonRpcProvider } from '@polkadot-api/json-rpc-provider-proxy';

export interface PauseController {
  middleware: (base: InnerJsonRpcProvider) => InnerJsonRpcProvider;
  pause: () => void;
  resume: () => void;
}

export function createPauseController(): PauseController {
  let paused = false;
  let destroyed = false;
  let base: InnerJsonRpcProvider | null = null;
  let onMessage: ((message: JsonRpcMessage) => void) | null = null;
  let onHalt: ((error?: unknown) => void) | null = null;
  let real: JsonRpcConnection | null = null;
  let buffer: JsonRpcRequest[] = [];
  // Our own halt schedules a re-invocation, so resume must not reuse the stale callbacks.
  let reinvocationPending = false;

  const connect = (): void => {
    if (base === null || onMessage === null || onHalt === null) {
      return;
    }
    const connection = base(onMessage, onHalt);
    real = connection;
    const queued = buffer;
    buffer = [];
    for (const message of queued) {
      connection.send(message);
    }
  };

  const middleware = (inner: InnerJsonRpcProvider): InnerJsonRpcProvider => {
    base = inner;
    return (onMsg, onH) => {
      reinvocationPending = false;
      // A new invocation is a fresh consumer, so the previous disconnect's `destroyed` must not stick.
      destroyed = false;
      onMessage = onMsg;
      onHalt = onH;
      real = null;
      if (!paused) {
        connect();
      }
      return {
        send: message => {
          if (real === null) {
            buffer.push(message);
          } else {
            real.send(message);
          }
        },
        disconnect: () => {
          destroyed = true;
          paused = false;
          buffer = [];
          real?.disconnect();
          real = null;
        },
      };
    };
  };

  const pause = (): void => {
    if (paused || destroyed) {
      return;
    }
    paused = true;
    if (real === null || onHalt === null) {
      return;
    }
    reinvocationPending = true;
    const live = real;
    real = null;
    // The socket detaches its listeners before closing, so the halt that drives the proxy replay is ours.
    live.disconnect();
    onHalt({ type: 'paused' });
  };

  const resume = (): void => {
    if (destroyed || !paused) {
      return;
    }
    paused = false;
    if (!reinvocationPending) {
      connect();
    }
  };

  return { middleware, pause, resume };
}
