// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createListeners, type Listeners, type Provider } from './provider.js';

/**
 * Two connected providers that deliver on a microtask, in order, and detach each buffer like a browser transfer. As a
 * browser port does, a message posted before its sender closes still arrives, and nothing reaches a closed receiver,
 * not even its other listeners once one of them closes it.
 */
export function createProviderPair(): { left: Provider; right: Provider; delivered: ArrayBuffer[] } {
  const delivered: ArrayBuffer[] = [];
  const leftSide = createListeners();
  const rightSide = createListeners();

  const createSide = (own: Listeners, peer: Listeners): Provider => ({
    post(data) {
      if (own.disposed()) {
        throw new Error('The provider is disposed');
      }
      const moved = structuredClone(data, { transfer: [data] });
      queueMicrotask(() => {
        if (peer.disposed()) {
          return;
        }
        delivered.push(moved);
        peer.deliver(moved);
      });
    },
    subscribe: own.subscribe,
    peerOrigin: () => null,
    dispose() {
      own.dispose();
    },
  });

  return {
    left: createSide(leftSide, rightSide),
    right: createSide(rightSide, leftSide),
    delivered,
  };
}
