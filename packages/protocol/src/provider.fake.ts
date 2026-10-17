import type { Provider } from './provider.js';

type Listener = (data: ArrayBuffer) => void;

interface Side {
  listeners: Set<Listener>;
  disposed: boolean;
}

function deliver(side: Side, data: ArrayBuffer): void {
  for (const listener of [...side.listeners]) {
    if (side.disposed) {
      return;
    }
    listener(data);
  }
}

/**
 * Two connected providers that deliver on a microtask, in order, and detach each buffer like a browser transfer. As a
 * browser port does, a message posted before its sender closes still arrives, and nothing reaches a closed receiver,
 * not even its other listeners once one of them closes it.
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
        deliver(peer, moved);
      });
    },
    subscribe(listener) {
      if (own.disposed) {
        return () => undefined;
      }
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
