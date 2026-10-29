// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page around the product frame for specs: it records what the frame shows, and its screens are disposers a spec
// puts up, which run once each as the page's screens come down.

import type { ProductFrameStatus, ProductFrameView, TitledProduct } from './createProductFrame.js';

export type ScreenName = 'page' | 'loading';

/** A page around the frame that records what the frame shows. Never throws. */
export function createFakeProductFrameView() {
  const attached: HTMLIFrameElement[] = [];
  const titles: TitledProduct[] = [];
  const statuses: ProductFrameStatus[] = [];
  let cleared = 0;
  const screens = new Map<ScreenName, () => void>();

  function clearScreen(name: ScreenName): void {
    const dispose = screens.get(name);
    screens.delete(name);
    dispose?.();
  }

  const view: ProductFrameView = {
    attachFrame: iframe => {
      attached.push(iframe);
    },
    showTitle: product => {
      titles.push(product);
    },
    clearScreens({ loading }) {
      clearScreen('page');
      if (loading) {
        clearScreen('loading');
      }
    },
    showStatus: status => {
      statuses.push(status);
    },
    clearMount: () => {
      cleared += 1;
    },
  };

  return {
    /** The view the frame is given. */
    view,
    /** Every frame handed to the layout, in order. */
    attached,
    /** Every product the tab title was shown for, in order. */
    titles,
    /** Every status the frame published, in order. */
    statuses,
    /** How many times the frame emptied its mount. */
    countMountsCleared: (): number => cleared,
    /** Puts up a screen whose dispose runs the first time the frame clears it. */
    showScreen,
  };

  function showScreen(name: ScreenName, dispose: () => void): void {
    screens.set(name, dispose);
  }
}

/** A frame as an opaque token: the runtime hands it on, listens for its load and compares its window by identity. */
export function createFakeIframe(): HTMLIFrameElement {
  // The runtime reads no other member of the element, so the token stands in for it.
  return Object.assign(new EventTarget(), { contentWindow: {} }) as unknown as HTMLIFrameElement;
}
