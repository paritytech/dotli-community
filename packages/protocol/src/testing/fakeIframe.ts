// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A mounted fake fires `load` as a page that loads would, or `error` when the test asks.

import { createFakeFrameWindow, type FakeFrameWindow } from './createFakeFrameWindow.js';
import type { Listener, MountEvent } from './types.js';

/** What the protocol frame reads and calls on its iframe. */
export class FakeIframe extends EventTarget {
  src = '';
  tabIndex = 0;
  readonly style = { cssText: '' };
  readonly attributes = new Map<string, string>();
  /** Null until mounted and again once removed, as in a browser. */
  contentWindow: FakeFrameWindow | null = null;
  isConnected = false;
  readonly #toHost: Listener;
  #window: FakeFrameWindow | null = null;
  #onRemove: (() => void) | null = null;

  constructor(toHost: Listener) {
    super();
    this.#toHost = toHost;
  }

  /** The window it was mounted with, kept after removal, since a message it sent before still names it as source. */
  get window(): FakeFrameWindow {
    if (this.#window === null) {
      throw new Error('the iframe was never mounted');
    }
    return this.#window;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  /** Called by the mount it is appended to. `fires` null leaves `load` to the test. */
  mount(onRemove: () => void, fires: MountEvent): void {
    this.isConnected = true;
    this.#window ??= createFakeFrameWindow({ toHost: this.#toHost });
    this.contentWindow = this.#window;
    this.#onRemove = onRemove;
    if (fires === null) {
      return;
    }
    queueMicrotask(() => {
      if (this.isConnected) {
        this.dispatchEvent(new Event(fires));
      }
    });
  }

  remove(): void {
    this.isConnected = false;
    this.contentWindow = null;
    this.#onRemove?.();
    this.#onRemove = null;
  }
}
