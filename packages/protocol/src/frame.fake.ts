// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A protocol frame without an iframe, for the layers above it. Each frame it builds is a real transport over an
// in-memory provider pair, with a real transport on the far side the test answers through. The test says when the
// frame is up and when it is lost. A frame's transport is handed out only once the test says it listens, as a real
// frame hands out its transport once its iframe loads, since a call starts the handshake. So calls made while it boots
// wait as they would on a real frame.

import { createStatusCell, realTimers, untilStatus, type Timers } from '@dotli/shared';
import { createTransport } from '@dotli/transport';
import { createProviderPair } from '@dotli/transport/testing';
import type { ProtocolFrame, ProtocolStatus } from './frame.js';
import { protocolSchema, type ProtocolTransport } from './schema.js';

export type FakeFrame = {
  frame: ProtocolFrame;
  /** The frame moving to `status`. Up, it builds a frame if there is none, and `listening` and `ready` connect it. */
  setStatus(status: ProtocolStatus): void;
  /** The frame being dropped with `error`, after its status says it is down. Its transport is disposed with `error`. */
  lose(error: Error): void;
  /** How many frames were built. */
  builds(): number;
};

type Built = {
  /** The host's side. */
  host: ProtocolTransport;
  /** The frame app's side, which serves the host. */
  serving: ProtocolTransport;
};

/**
 * Up and ready unless `options.status` says otherwise, or the test moves it. `serve` sets up each frame's serving
 * transport as it is built, and each frame's transport waits on `options.timers`. A `whenReady` or `transport` on an
 * idle or failed frame builds one and starts it booting, as the frame does. A `transport` waits for the test to set
 * `listening` or `ready`, and a `whenReady` for `ready`. Each fails when the frame is then lost or goes idle.
 */
export function createFakeFrame(
  serve: (serving: ProtocolTransport) => void = () => undefined,
  options: { status?: ProtocolStatus; timers?: Timers } = {},
): FakeFrame {
  const timers = options.timers ?? realTimers;
  // A listener's throw fails the test that set the status.
  const status = createStatusCell<ProtocolStatus>(options.status ?? 'ready', {
    onListenerError: error => {
      throw error;
    },
  });
  let lostWith: Error = new Error('lost');
  let builds = 0;
  let current: Built | null = null;

  const build = (): Built => {
    builds += 1;
    const { left, right } = createProviderPair();
    const hello = { resolutionId: null };
    const serving = createTransport(protocolSchema, right, { handshake: 'respond', hello });
    serve(serving);
    return { host: createTransport(protocolSchema, left, { handshake: 'offer', hello, timers }), serving };
  };

  /** Builds a frame for a status that is up if there is none, and connects it once it listens. */
  const bringUp = (next: ProtocolStatus): void => {
    if (next === 'idle' || next === 'failed') {
      return;
    }
    current ??= build();
    if (next === 'listening' || next === 'ready') {
      current.host.connect();
    }
  };

  const setStatus = (next: ProtocolStatus): void => {
    bringUp(next);
    status.set(next);
  };

  const boot = (): Built => {
    const now = status.get();
    if (now === 'idle' || now === 'failed') {
      setStatus('booting');
    }
    current ??= build();
    return current;
  };

  bringUp(status.get());

  /** The host's side of the frame there is once the status is one of `reached`, booting one if there is none. */
  const until = (reached: readonly ProtocolStatus[]): Promise<ProtocolTransport> => {
    boot();
    let host: ProtocolTransport | null = null;
    return untilStatus(status, next => {
      if (reached.includes(next)) {
        host = current?.host ?? null;
        return host !== null || lostWith;
      }
      if (next === 'failed' || next === 'idle') {
        return next === 'failed' ? lostWith : new Error('frame went idle');
      }
      return false;
    }).then(() => {
      if (host === null) {
        throw lostWith;
      }
      return host;
    });
  };

  return {
    frame: {
      getStatus: status.get,
      subscribeStatus: status.subscribe,
      configure: () => undefined,
      transport: () => until(['listening', 'ready']),
      whenReady: () => until(['ready']),
      // The facades never read it, and this fake's frame speaks the host's schema.
      onVersionMismatch: () => () => undefined,
    },
    setStatus,
    lose(error) {
      lostWith = error;
      const lost = current;
      current = null;
      setStatus('failed');
      lost?.host.dispose(error);
      lost?.serving.dispose(error);
    },
    builds: () => builds,
  };
}
