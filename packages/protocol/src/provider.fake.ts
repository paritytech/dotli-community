import type { Provider } from './provider.js';

type Listener = (data: ArrayBuffer) => void;

/** Two connected providers that deliver on a microtask, in order, and detach each buffer like a browser transfer. */
export function createProviderPair(): { left: Provider; right: Provider; delivered: ArrayBuffer[] } {
  const delivered: ArrayBuffer[] = [];
  const leftListeners = new Set<Listener>();
  const rightListeners = new Set<Listener>();

  const createSide = (own: Set<Listener>, peer: Set<Listener>): Provider => {
    let disposed = false;
    return {
      post(data) {
        if (disposed) {
          throw new Error('The provider is disposed');
        }
        const moved = structuredClone(data, { transfer: [data] });
        queueMicrotask(() => {
          if (disposed) {
            return;
          }
          delivered.push(moved);
          for (const listener of [...peer]) {
            listener(moved);
          }
        });
      },
      subscribe(listener) {
        own.add(listener);
        return () => {
          own.delete(listener);
        };
      },
      peerOrigin: () => null,
      dispose() {
        disposed = true;
        own.clear();
      },
    };
  };

  return {
    left: createSide(leftListeners, rightListeners),
    right: createSide(rightListeners, leftListeners),
    delivered,
  };
}
