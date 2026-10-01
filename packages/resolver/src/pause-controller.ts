// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pause and resume for a ws provider's socket.
 *
 * This has the same contract as the pause controller in
 * `@novasamatech/host-substrate-chain-connection` (paritytech/triangle-js-sdks,
 * Apache-2.0), which that package does not export. Pausing closes the live
 * socket, reports a halt so the provider proxy re-follows and buffers sends,
 * and holds back reconnects. Resuming opens a fresh socket and flushes what
 * was buffered.
 */
import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import type { InnerJsonRpcProvider } from '@polkadot-api/json-rpc-provider-proxy';

export interface PauseController {
  /** Plugs into the ws provider's `middleware` option. */
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
  // A halt we fired already scheduled a middleware re-invocation, so resume
  // must defer to it rather than reuse the stale onMessage/onHalt pair.
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
      // A new invocation means a fresh consumer, so a `destroyed` left by the
      // previous disconnect must not stick: it only gates pause/resume between
      // that disconnect and the next invocation.
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
    // The ws socket detaches its listeners before closing, so no halt fires
    // from there. Report it by hand to drive the proxy's replay.
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
