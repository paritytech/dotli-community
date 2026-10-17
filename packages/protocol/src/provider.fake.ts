import type { Provider } from './provider.js';

type Listener = (data: ArrayBuffer) => void;

interface Side {
  listeners: Set<Listener>;
  disposed: boolean;
}

/**
 * Two connected providers that deliver on a microtask, in order, and detach each buffer like a browser transfer. As a
 * browser port does, a message posted before its sender closes still arrives, and nothing reaches a closed receiver.
 */
export function createProviderPair(): { left: Provider; right: Provider; delivered: ArrayBuffer[] } {
  const delivered: ArrayBuffer[] = [];
  const leftSide: Side = { listeners: new Set(), disposed: false };
  const rightSide: Side = { listeners: new Set(), disposed: false };

  const createSide = (own: Side, peer: Side): Provider => ({
    post(data) {
      if (own.disposed) {
        throw new Error('The provider is disposed');
      }
      const moved = structuredClone(data, { transfer: [data] });
      queueMicrotask(() => {
        if (peer.disposed) {
          return;
        }
        delivered.push(moved);
        for (const listener of [...peer.listeners]) {
          listener(moved);
        }
      });
    },
    subscribe(listener) {
      own.listeners.add(listener);
      return () => {
        own.listeners.delete(listener);
      };
    },
    peerOrigin: () => null,
    dispose() {
      own.disposed = true;
      own.listeners.clear();
    },
  });

  return {
    left: createSide(leftSide, rightSide),
    right: createSide(rightSide, leftSide),
    delivered,
  };
}
