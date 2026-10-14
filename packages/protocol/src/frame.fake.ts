// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A protocol frame without an iframe, for the layers above it. The test says when it is up, what it sends and when it
// is lost. A `whenUp` on an idle or failed frame asks for one, so it starts booting. A `whenUp` waits for the status
// the test sets, and fails when the frame is then lost or goes idle.

import type { ProtocolFrame, ProtocolStatus } from './frame.js';
import type { ProtocolEnvelope, ProtocolRequestEnvelope } from './messages.js';

export interface FakeFrame {
  frame: ProtocolFrame;
  /** Every request posted, in order. */
  posted: ProtocolRequestEnvelope[];
  /** The frame sending a message. */
  send(envelope: ProtocolEnvelope): void;
  /** The frame moving to `status`. */
  setStatus(status: ProtocolStatus): void;
  /** The frame being dropped with `error`, after its status says it is down. */
  lose(error: Error): void;
}

/**
 * Up and ready unless the test moves it. A `whenUp` on an idle or failed frame starts it booting, as the frame does. A
 * `whenUp` waits for the status the test sets, and fails when the frame is then lost or goes idle.
 */
export function createFakeFrame(): FakeFrame {
  let status: ProtocolStatus = 'ready';
  let lostWith: Error = new Error('lost');
  let losses = 0;
  const statusListeners = new Set<(status: ProtocolStatus) => void>();
  const envelopeListeners = new Set<(envelope: ProtocolEnvelope) => void>();
  const lostListeners = new Set<(error: Error) => void>();
  const posted: ProtocolRequestEnvelope[] = [];
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
        if (status === 'idle' || status === 'failed') {
          setStatus('booting');
        }
        return new Promise<void>((resolve, reject) => {
          const settle = (next: ProtocolStatus): boolean => {
            if (next === 'ready' || (wanted === 'listening' && next === 'listening')) {
              resolve();
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
      post(message) {
        posted.push(message as ProtocolRequestEnvelope);
      },
      onEnvelope: subscribe(envelopeListeners),
      onLost: subscribe(lostListeners),
      losses: () => losses,
    },
    posted,
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
