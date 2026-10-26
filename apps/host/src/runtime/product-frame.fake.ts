// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page around the product frame for specs: it records what the frame shows, and its screens are disposers a spec
// puts up, which run once each as the page's screens come down.

import type { ProductFrameStatus, ProductFrameView, TitledProduct } from './product-frame.js';

export type ScreenName = 'page' | 'loading';

export type FakeProductFrameView = {
  view: ProductFrameView;
  /** Every frame handed to the layout, in order. */
  attached: HTMLIFrameElement[];
  /** Every product the tab title was shown for, in order. */
  titles: TitledProduct[];
  /** Every status the frame published, in order. */
  statuses: ProductFrameStatus[];
  /** How many times the frame emptied its mount. */
  mountsCleared: () => number;
  /** Puts up a screen whose dispose runs the first time the frame clears it. */
  showScreen: (name: ScreenName, dispose: () => void) => void;
};

export function fakeProductFrameView(): FakeProductFrameView {
  const attached: HTMLIFrameElement[] = [];
  const titles: TitledProduct[] = [];
  const statuses: ProductFrameStatus[] = [];
  let cleared = 0;
  const screens = new Map<ScreenName, () => void>();
  const clear = (name: ScreenName): void => {
    const dispose = screens.get(name);
    screens.delete(name);
    dispose?.();
  };
  return {
    view: {
      attachFrame: iframe => {
        attached.push(iframe);
      },
      showTitle: product => {
        titles.push(product);
      },
      clearScreens: ({ loading }) => {
        clear('page');
        if (loading) {
          clear('loading');
        }
      },
      showStatus: status => {
        statuses.push(status);
      },
      clearMount: () => {
        cleared += 1;
      },
    },
    attached,
    titles,
    statuses,
    mountsCleared: () => cleared,
    showScreen: (name, dispose) => {
      screens.set(name, dispose);
    },
  };
}

/** A frame as an opaque token: the runtime hands it on, listens for its load and compares its window by identity. */
export function fakeIframe(): HTMLIFrameElement {
  return Object.assign(new EventTarget(), { contentWindow: {} }) as unknown as HTMLIFrameElement;
}
