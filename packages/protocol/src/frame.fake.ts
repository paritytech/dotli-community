// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A protocol frame without an iframe, for the layers above it. Each frame it builds is a real consumer transport over
// an in-memory provider pair, with a real serving transport the test answers through. The test says when the frame is
// up and when it is lost. A frame's handshake is answered only once the test says it listens, so calls made while it
// boots wait in the transport's queue as they would on a real frame.

import type { ProtocolFrame, ProtocolStatus } from './frame.js';
import { createProviderPair } from './provider.fake.js';
import { createConsumerTransport, type ConsumerTransport } from './transport-consumer.js';
import { createServingTransport, type ServingTransport } from './transport-serving.js';

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
  consumer: ConsumerTransport;
  serving: ServingTransport;
}

/**
 * Up and ready unless `options.status` says otherwise, or the test moves it. `serve` sets up each frame's serving
 * transport as it is built. A `whenUp` or `transport` on an idle or failed frame builds one and starts it booting, as
 * the frame does. A `whenUp` waits for the status the test sets, and fails when the frame is then lost or goes idle.
 */
export function createFakeFrame(
  serve: (serving: ServingTransport) => void = () => undefined,
  options: { status?: ProtocolStatus } = {},
): FakeFrame {
  let status: ProtocolStatus = options.status ?? 'ready';
  let lostWith: Error = new Error('lost');
  let losses = 0;
  let builds = 0;
  let current: Built | null = null;
  const statusListeners = new Set<(status: ProtocolStatus) => void>();
  const lostListeners = new Set<(error: Error) => void>();
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
    const serving = createServingTransport(right, { side: 'frame' });
    serve(serving);
    return { consumer: createConsumerTransport(left, { side: 'host' }), serving };
  };

  const setStatus = (next: ProtocolStatus): void => {
    if (next === 'booting' && current === null) {
      current = build();
    }
    if (next === 'listening' || next === 'ready') {
      current?.consumer.connect();
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
      current.consumer.connect();
    }
  }

  return {
    frame: {
      getStatus: () => status,
      subscribeStatus: subscribe(statusListeners),
      configure: () => undefined,
      transport: () => Promise.resolve(boot().consumer),
      whenUp(wanted) {
        boot();
        return new Promise<ConsumerTransport>((resolve, reject) => {
          const settle = (next: ProtocolStatus): boolean => {
            if (next === 'ready' || (wanted === 'listening' && next === 'listening')) {
              if (current === null) {
                reject(lostWith);
              } else {
                resolve(current.consumer);
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
      onLost: subscribe(lostListeners),
      // The facades never read it, and this fake's frame speaks the host wire.
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
      lost?.consumer.dispose(error);
      lost?.serving.dispose(error);
      for (const listener of [...lostListeners]) {
        listener(error);
      }
    },
    builds: () => builds,
  };
}
