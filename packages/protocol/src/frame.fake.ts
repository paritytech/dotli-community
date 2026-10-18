// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A protocol frame without an iframe, for the layers above it. Each frame it builds is a real transport over an
// in-memory provider pair, with a real transport on the far side the test answers through. The test says when the
// frame is up and when it is lost. A frame's handshake is answered only once the test says it listens, so calls made
// while it boots wait in the transport's queue as they would on a real frame.

import { realTimers, type Timers } from '@dotli/shared';
import { createTransport } from '@dotli/transport';
import { createProviderPair } from '@dotli/transport/testing';
import type { ProtocolFrame, ProtocolStatus } from './frame.js';
import { protocolSchema, type ProtocolTransport } from './schema.js';

export interface FakeFrame {
  frame: ProtocolFrame;
  /** The frame moving to `status`. `booting` builds a frame if there is none, `listening` and `ready` connect it. */
  setStatus(status: ProtocolStatus): void;
  /** The frame being dropped with `error`, after its status says it is down. Its transport is disposed with `error`. */
  lose(error: Error): void;
  /** How many frames were built. */
  builds(): number;
}

interface Built {
  /** The host's side. */
  host: ProtocolTransport;
  /** The frame app's side, which serves the host. */
  serving: ProtocolTransport;
}

/**
 * Up and ready unless `options.status` says otherwise, or the test moves it. `serve` sets up each frame's serving
 * transport as it is built, and each frame's transport waits on `options.timers`. A `whenReady` or `transport` on an
 * idle or failed frame builds one and starts it booting, as the frame does. A `whenReady` waits for the test to set
 * `ready`, and fails when the frame is then lost or goes idle.
 */
export function createFakeFrame(
  serve: (serving: ProtocolTransport) => void = () => undefined,
  options: { status?: ProtocolStatus; timers?: Timers } = {},
): FakeFrame {
  const timers = options.timers ?? realTimers;
  let status: ProtocolStatus = options.status ?? 'ready';
  let lostWith: Error = new Error('lost');
  let losses = 0;
  let builds = 0;
  let current: Built | null = null;
  const statusListeners = new Set<(status: ProtocolStatus) => void>();
  const subscribe =
    <T>(listeners: Set<(event: T) => void>) =>
    (listener: (event: T) => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };

  const build = (): Built => {
    builds += 1;
    const { left, right } = createProviderPair();
    const hello = { resolutionId: null };
    const serving = createTransport(protocolSchema, right, { handshake: 'accept', hello });
    serve(serving);
    return { host: createTransport(protocolSchema, left, { handshake: 'open', hello, timers }), serving };
  };

  const setStatus = (next: ProtocolStatus): void => {
    if (next === 'booting' && current === null) {
      current = build();
    }
    if (next === 'listening' || next === 'ready') {
      current?.host.connect();
    }
    status = next;
    for (const listener of [...statusListeners]) {
      listener(next);
    }
  };

  const boot = (): Built => {
    if (status === 'idle' || status === 'failed') {
      setStatus('booting');
    }
    current ??= build();
    return current;
  };

  if (status !== 'idle' && status !== 'failed') {
    current = build();
    if (status === 'listening' || status === 'ready') {
      current.host.connect();
    }
  }

  return {
    frame: {
      getStatus: () => status,
      subscribeStatus: subscribe(statusListeners),
      configure: () => undefined,
      transport: () => Promise.resolve(boot().host),
      whenReady() {
        boot();
        return new Promise<ProtocolTransport>((resolve, reject) => {
          const settle = (next: ProtocolStatus): boolean => {
            if (next === 'ready') {
              if (current === null) {
                reject(lostWith);
              } else {
                resolve(current.host);
              }
              return true;
            }
            if (next === 'failed' || next === 'idle') {
              reject(next === 'failed' ? lostWith : new Error('frame went idle'));
              return true;
            }
            return false;
          };
          if (settle(status)) {
            return;
          }
          const stop = subscribe(statusListeners)(next => {
            if (settle(next)) {
              stop();
            }
          });
        });
      },
      // The facades never read it, and this fake's frame speaks the host's schema.
      onVersionMismatch: () => () => undefined,
      losses: () => losses,
    },
    setStatus,
    lose(error) {
      lostWith = error;
      losses += 1;
      const lost = current;
      current = null;
      setStatus('failed');
      lost?.host.dispose(error);
      lost?.serving.dispose(error);
    },
    builds: () => builds,
  };
}
