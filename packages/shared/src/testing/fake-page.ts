// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The page's document as a spec sees it: its visibility and the `visibilitychange` it fires. */
class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';

  get hidden(): boolean {
    return this.visibilityState !== 'visible';
  }
}

/** The page's window as a spec sees it: connectivity, and the `online`, `offline` and lifecycle events it fires. */
class FakeWindow extends EventTarget {
  onLine = true;
}

/** The page a spec flips, firing each event on the target the browser fires it on. */
export class FakePage {
  readonly document = new FakeDocument();
  readonly window = new FakeWindow();

  setVisibility(state: DocumentVisibilityState): void {
    this.document.visibilityState = state;
    this.document.dispatchEvent(new Event('visibilitychange'));
  }

  setOnline(online: boolean): void {
    this.window.onLine = online;
    this.window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  }

  /** Hides the page, into the back/forward cache when `persisted`. Node has no PageTransitionEvent to carry it. */
  hide(persisted: boolean): void {
    this.window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted }));
  }
}
