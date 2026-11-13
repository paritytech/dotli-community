// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The runtime's product frame view answered with the page's frame layout, screens and loading screen.

import { pageScreen } from '@dotli/ui';
import type { ProductFrameView } from './runtime/createProductFrame.js';
import { loadViolationPanelMount } from './lazy.js';
import { pageLoading, type LoadingController } from './createLoadingController.js';
import { productFrameLayout, type ProductFrameLayout } from './createProductFrameLayout.js';
import { getProductTitle } from './getProductTitle.js';

/** The parts of the page the product frame shares. */
type Params = {
  /** Where the frame is laid out. */
  layout: Pick<ProductFrameLayout, 'attach'>;
  body: () => Pick<HTMLElement, 'style'>;
  /** Where the product frame mounts. */
  container: () => Pick<HTMLElement, 'dataset' | 'replaceChildren'>;
  /** Takes the full-page screen over the frame down. */
  clearScreen: (typeof pageScreen)['clear'];
  /** Ends the loading screen. */
  hideLoading: LoadingController['hideLoading'];
  /** Writes the tab title. */
  setTitle: (title: string) => void;
};

/** Returns the frame's surroundings: the layout, the tab title, the screens over it and, in checker builds, the panel. */
export function createProductFrameView({
  layout,
  body,
  container,
  clearScreen,
  hideLoading,
  setTitle,
}: Params): ProductFrameView {
  return {
    attachFrame(iframe) {
      layout.attach(iframe);
      const { style } = body();
      style.margin = '0';
      style.overflow = 'hidden';
    },
    showTitle(product) {
      setTitle(getProductTitle(product));
    },
    clearScreens({ loading }) {
      clearScreen();
      if (loading) {
        hideLoading();
      }
    },
    showStatus(status) {
      container().dataset['productFrame'] = status;
    },
    clearMount() {
      container().replaceChildren();
    },
    // Behind the compile-time flag, so other builds drop the panel's chunk.
    loadCheckerPanel:
      import.meta.env.VITE_SANDBOX_CHECKER !== 'true'
        ? undefined
        : async () => (await loadViolationPanelMount()).mountViolationPanel,
  };
}

/** Where the page mounts the product frame. */
export function getProductFrameContainer(): HTMLElement {
  return document.getElementById('app') ?? document.body;
}

/** The page's frame view, over its frame layout, body, screens, loading screen and document title. */
export const productFrameView: ProductFrameView = createProductFrameView({
  layout: productFrameLayout,
  body: () => document.body,
  container: getProductFrameContainer,
  clearScreen: pageScreen.clear,
  hideLoading: pageLoading.hideLoading,
  setTitle: title => {
    document.title = title;
  },
});
