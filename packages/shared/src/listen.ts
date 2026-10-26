// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Event listening that hands back its own stop, so a caller keeps one function instead of the handler and its type.

/** The events a target fires by name, as the DOM types them for a window, a document or the cookie store. */
type EventMapOf<T> = T extends Window
  ? WindowEventMap
  : T extends Document
    ? DocumentEventMap
    : T extends CookieStore
      ? CookieStoreEventMap
      : Record<string, Event>;

/** The event `type` on `T`, or a plain `Event` for a name its map does not know. */
type EventOf<T, K extends string> = K extends keyof EventMapOf<T> ? EventMapOf<T>[K] : Event;

/** Calls `handler` for each `type` event on `target` until the returned stop. */
export function listen<T extends EventTarget, K extends string>(
  target: T,
  type: K,
  handler: (event: EventOf<T, K>) => void,
): () => void {
  // The DOM types a listener by its event only on the target's own overloads.
  const listener = handler as EventListener;
  target.addEventListener(type, listener);
  return () => {
    target.removeEventListener(type, listener);
  };
}

/** A page's document as far as its visibility goes. */
export type VisibilitySource = EventTarget & { readonly visibilityState: DocumentVisibilityState };

/** Calls `handler` each time the page becomes visible, never as it is hidden, until the returned stop. */
export function onDocumentVisible(doc: VisibilitySource, handler: () => void): () => void {
  return listen(doc, 'visibilitychange', () => {
    if (doc.visibilityState === 'visible') {
      handler();
    }
  });
}

/**
 * Calls `handler` each time the user comes back to the page, until the returned stop. A window beside another stays
 * visible while the user works in the other, so coming back to it is its focus, and to a tab its turning visible.
 */
export function onPageReturn(doc: VisibilitySource, win: EventTarget, handler: () => void): () => void {
  const stops = [onDocumentVisible(doc, handler), listen(win, 'focus', handler)];
  return () => {
    for (const stop of stops) {
      stop();
    }
  };
}
