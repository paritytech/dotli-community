/**
 * Providers move bytes between two contexts and know nothing about their meaning. The transport above them frames,
 * encodes and decodes.
 */
import type { MessageTarget } from './frame.js';

export interface Provider {
  /** Transfers the buffer to the peer, so the caller must not reuse it. Throws after `dispose`. */
  post(data: ArrayBuffer): void;
  /**
   * Hears each message that arrives while the listener is subscribed. A provider holds nothing for a listener yet to
   * come, so its owner subscribes in the turn that creates it. Does nothing after `dispose`.
   */
  subscribe(listener: (data: ArrayBuffer) => void): () => void;
  /** The origin the peer is known by, or null when it has none or none is admitted yet. */
  peerOrigin(): string | null;
  dispose(): void;
}

export interface WindowLike {
  postMessage(message: unknown, targetOrigin: string, transfer: Transferable[]): void;
}

export type PortLike = Pick<
  MessagePort,
  'postMessage' | 'addEventListener' | 'removeEventListener' | 'start' | 'close'
>;

export interface WindowProviderDeps {
  listen: MessageTarget;
  peer: () => WindowLike | null;
  /** A fixed origin, or a predicate whose first origin to send bytes is locked for the rest of the provider's life. */
  origin: string | ((origin: string) => boolean);
  /** Called for data from the admitted peer that is not an `ArrayBuffer`. */
  onNotBytes?: () => void;
}

/** Hears its peer from the moment it is created, and delivers only to listeners subscribed by then. */
export function createWindowProvider(deps: WindowProviderDeps): Provider {
  const { listen, peer, origin, onNotBytes } = deps;
  const listeners = new Set<(data: ArrayBuffer) => void>();
  let locked: string | null = typeof origin === 'string' ? origin : null;
  let disposed = false;

  const onMessage = (event: MessageEvent): void => {
    const source = peer();
    if (source === null || event.source !== source) {
      return;
    }
    const admitted = locked === null ? typeof origin !== 'string' && origin(event.origin) : event.origin === locked;
    if (!admitted) {
      return;
    }
    const data: unknown = event.data;
    if (!(data instanceof ArrayBuffer)) {
      onNotBytes?.();
      return;
    }
    // Only bytes lock the origin, so an object from an allowed origin leaves the lock to the peer that speaks the wire.
    locked ??= event.origin;
    for (const listener of [...listeners]) {
      if (disposed) {
        return;
      }
      listener(data);
    }
  };
  listen.addEventListener('message', onMessage);

  return {
    post(data) {
      if (disposed) {
        throw new Error('The provider is disposed');
      }
      const target = peer();
      if (target === null) {
        throw new Error('The peer window is gone');
      }
      if (locked === null) {
        throw new Error('No peer origin is admitted yet');
      }
      target.postMessage(data, locked, [data]);
    },
    subscribe(listener) {
      if (disposed) {
        return () => undefined;
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    peerOrigin: () => locked,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      listeners.clear();
      listen.removeEventListener('message', onMessage);
    },
  };
}

interface PortProviderOptions {
  /** Unset or true, `dispose` closes the port. False leaves the port open for its owner to close. */
  closeOnDispose?: boolean;
}

/** Starts the port, so it hears from the moment it is created and delivers only to listeners subscribed by then. */
export function createPortProvider(port: PortLike, options: PortProviderOptions = {}): Provider {
  const closeOnDispose = options.closeOnDispose ?? true;
  const listeners = new Set<(data: ArrayBuffer) => void>();
  let disposed = false;

  const onMessage = (event: MessageEvent): void => {
    const data: unknown = event.data;
    if (!(data instanceof ArrayBuffer)) {
      return;
    }
    for (const listener of [...listeners]) {
      if (disposed) {
        return;
      }
      listener(data);
    }
  };
  port.addEventListener('message', onMessage);
  port.start();

  return {
    post(data) {
      if (disposed) {
        throw new Error('The provider is disposed');
      }
      port.postMessage(data, [data]);
    },
    subscribe(listener) {
      if (disposed) {
        return () => undefined;
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    peerOrigin: () => null,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      listeners.clear();
      port.removeEventListener('message', onMessage);
      if (closeOnDispose) {
        port.close();
      }
    },
  };
}
