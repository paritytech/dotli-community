// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The page's visibility and connectivity, which a spec flips and whose events it fires. */
export class FakePage extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
  onLine = true;

  get hidden(): boolean {
    return this.visibilityState !== 'visible';
  }

  setVisibility(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }

  setOnline(online: boolean): void {
    this.onLine = online;
    this.dispatchEvent(new Event(online ? 'online' : 'offline'));
  }
}
