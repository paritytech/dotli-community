// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page around the product frame for specs: it records what the frame shows, and its screens are disposers a spec
// puts up, which run once each as the page's screens come down.

import type { ProductFrameView, TitledProduct } from './product-frame.js';

export type ScreenName = 'page' | 'loading';

export interface FakeProductFrameView {
  view: ProductFrameView;
  /** Every frame handed to the layout, in order. */
  attached: HTMLIFrameElement[];
  /** Every product the tab title was shown for, in order. */
  titles: TitledProduct[];
  /** Puts up a screen whose dispose runs the first time the frame clears it. */
  showScreen: (name: ScreenName, dispose: () => void) => void;
}

export function fakeProductFrameView(): FakeProductFrameView {
  const attached: HTMLIFrameElement[] = [];
  const titles: TitledProduct[] = [];
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
    },
    attached,
    titles,
    showScreen: (name, dispose) => {
      screens.set(name, dispose);
    },
  };
}
