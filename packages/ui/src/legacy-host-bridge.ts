// DEPRECATED — legacy host-API backward-compat transport shim.
//
// The TrUAPI host shuttles product frames over a transferred `MessagePort`.
// Products built on the older Nova host-api stack (the `@novasamatech` packages;
// e.g. apps still on `@parity/product-sdk`) instead shuttle the SAME wire bytes
// the old way: raw `Uint8Array` frames to/from `window.parent`. Only the
// transport differs, so this is a pure byte bridge — no per-method translation,
// no `@novasamatech/*` dependency.
//
// Remove this file (and the probe in `bridge.ts`) once products migrate to
// `@parity/truapi`.

import type { WireProvider } from "@parity/truapi";

/**
 * A {@link WireProvider} over `window.postMessage`, matching the legacy Nova
 * host-api iframe transport. Pipe it into the core with `pipeProviders` exactly
 * like the MessagePort path.
 */
export interface WindowMessageProvider extends WireProvider {
  /** Replay a frame already read off the `window` (the probe's detection frame). */
  injectInbound(message: Uint8Array): void;
}

let warned = false;

export function createWindowMessageProvider(
  targetWindow: Window,
): WindowMessageProvider {
  if (!warned) {
    warned = true;
    console.warn(
      "[dotli] legacy host-API transport bridge active — migrate this product to @parity/truapi.",
    );
  }

  const subscribers = new Set<(message: Uint8Array) => void>();
  const deliver = (message: Uint8Array): void => {
    for (const callback of subscribers) {
      callback(message);
    }
  };
  const onMessage = (event: MessageEvent): void => {
    if (event.source === targetWindow && event.data instanceof Uint8Array) {
      deliver(event.data);
    }
  };
  window.addEventListener("message", onMessage);

  return {
    // "*" matches the credentialless product iframe (its origin reports "null").
    postMessage(message) {
      targetWindow.postMessage(message, "*");
    },
    subscribe(callback) {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },
    injectInbound: deliver,
    dispose() {
      window.removeEventListener("message", onMessage);
      subscribers.clear();
    },
  };
}
