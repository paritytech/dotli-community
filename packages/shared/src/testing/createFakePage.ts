// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The page a spec flips, firing each event on the target the browser fires it on. */
export type FakePage = ReturnType<typeof createFakePage>;

/** A page whose visibility and connectivity a spec flips, firing the events a browser would. */
export function createFakePage() {
  let visibilityState: DocumentVisibilityState = 'visible';
  let onLine = true;

  /** The page's document as a spec sees it: its visibility and the `visibilitychange` it fires. */
  const document = {
    ...bindEventTarget(new EventTarget()),
    get visibilityState(): DocumentVisibilityState {
      return visibilityState;
    },
    get hidden(): boolean {
      return visibilityState !== 'visible';
    },
  };

  /** The page's window as a spec sees it: connectivity, and the `online`, `offline` and lifecycle events it fires. */
  const window = {
    ...bindEventTarget(new EventTarget()),
    get onLine(): boolean {
      return onLine;
    },
  };

  return {
    document,
    window,
    setVisibility(state: DocumentVisibilityState): void {
      visibilityState = state;
      document.dispatchEvent(new Event('visibilitychange'));
    },
    setOnline(online: boolean): void {
      onLine = online;
      window.dispatchEvent(new Event(online ? 'online' : 'offline'));
    },
    /** Hides the page, into the back/forward cache when `persisted`. Node has no PageTransitionEvent to carry it. */
    hide(persisted: boolean): void {
      window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted }));
    },
  };
}

/** The listener methods of `target`, bound to it, so a plain object carries them. */
function bindEventTarget(target: EventTarget) {
  return {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  };
}
