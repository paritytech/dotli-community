// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createListeners, type Listeners } from './createListeners.js';
import type { Provider } from './provider.js';
import { toTransferableBuffer } from './toTransferableBuffer.js';

/**
 * Two connected providers that deliver on a microtask, in order, and detach each buffer like a browser transfer. As a
 * browser port does, a message posted before its sender closes still arrives, and nothing reaches a closed receiver,
 * not even its other listeners once one of them closes it.
 */
export function createProviderPair(): { left: Provider; right: Provider; delivered: Uint8Array[] } {
  const delivered: Uint8Array[] = [];
  const leftSide = createListeners();
  const rightSide = createListeners();

  return {
    left: createSide(leftSide, rightSide),
    right: createSide(rightSide, leftSide),
    delivered,
  };

  function createSide(own: Listeners, peer: Listeners): Provider {
    return {
      isCorrectEnvironment: () => true,
      postMessage(message) {
        if (own.isDisposed()) {
          throw new Error('The provider is disposed');
        }
        const buffer = toTransferableBuffer(message);
        const moved = new Uint8Array(structuredClone(buffer, { transfer: [buffer] }));
        queueMicrotask(() => {
          if (peer.isDisposed()) {
            return;
          }
          delivered.push(moved);
          peer.deliver(moved);
        });
      },
      subscribe: own.subscribe,
      dispose() {
        own.dispose();
      },
    };
  }
}
