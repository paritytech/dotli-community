// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A protocol frame without an iframe, for the layers above it. The test says when it is up, what it sends and when it
// is lost.

import type { ProtocolFrame, ProtocolStatus } from './frame.js';
import type { ProtocolEnvelope, ProtocolRequestEnvelope } from './messages.js';

export interface FakeFrame {
  frame: ProtocolFrame;
  /** Every request posted, in order. */
  posted: ProtocolRequestEnvelope[];
  /** What each `whenUp` call waited for, in order. */
  waits: ('listening' | 'ready')[];
  /** The frame sending a message. */
  send(envelope: ProtocolEnvelope): void;
  /** The frame moving to `status`. */
  setStatus(status: ProtocolStatus): void;
  /** The frame being dropped with `error`, after its status says it is down. */
  lose(error: Error): void;
}

/** Up and ready unless the test moves it, so a `whenUp` resolves at once. Once lost, a `whenUp` fails with why. */
export function createFakeFrame(): FakeFrame {
  let status: ProtocolStatus = 'ready';
  let lostWith: Error = new Error('lost');
  let losses = 0;
  const statusListeners = new Set<(status: ProtocolStatus) => void>();
  const envelopeListeners = new Set<(envelope: ProtocolEnvelope) => void>();
  const lostListeners = new Set<(error: Error) => void>();
  const posted: ProtocolRequestEnvelope[] = [];
  const waits: ('listening' | 'ready')[] = [];
  const subscribe =
    <T>(listeners: Set<(event: T) => void>) =>
    (listener: (event: T) => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };
  const setStatus = (next: ProtocolStatus): void => {
    status = next;
    for (const listener of [...statusListeners]) {
      listener(next);
    }
  };
  return {
    frame: {
      getStatus: () => status,
      subscribeStatus: subscribe(statusListeners),
      configure: () => undefined,
      whenUp(wanted) {
        waits.push(wanted);
        return status === 'failed' ? Promise.reject(lostWith) : Promise.resolve();
      },
      post(message) {
        posted.push(message as ProtocolRequestEnvelope);
      },
      onEnvelope: subscribe(envelopeListeners),
      onLost: subscribe(lostListeners),
      losses: () => losses,
    },
    posted,
    waits,
    send(envelope) {
      for (const listener of [...envelopeListeners]) {
        listener(envelope);
      }
    },
    setStatus,
    lose(error) {
      lostWith = error;
      losses += 1;
      setStatus('failed');
      for (const listener of [...lostListeners]) {
        listener(error);
      }
    },
  };
}
