// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The window channel seam a page and its session window talk through. */

import { listen } from '@dotli/shared';

/** The part of a `Window` either side talks to. */
export type WindowHandle = {
  /** Posts `message` to the window, delivered only when its origin is `targetOrigin`, unless that is `*`. */
  postMessage(message: unknown, targetOrigin: string): void;
  /** Brings the window to the front. */
  focus(): void;
  /** Closes the window. */
  close(): void;
  /** True once the window is gone. */
  readonly closed: boolean;
};

/** The part of a `message` event either side reads. */
export type MessageEventLike = {
  /** The posted message, unparsed. */
  data: unknown;
  /** The sender's origin, which the browser vouches for. */
  origin: string;
  /** The sender's window. */
  source: unknown;
};

/** Hears the page's own `message` events until the returned stop. */
export function listenToMessages(handler: (event: MessageEventLike) => void): () => void {
  return listen({ target: window, type: 'message', handler });
}
