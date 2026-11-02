// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The runtime's product frame view answered with the page's frame layout, screens and loading screen.

import { pageScreen } from '@dotli/ui';
import type { ProductFrameView } from './runtime/createProductFrame.js';
import { loadViolationPanelMount } from './lazy.js';
import { pageLoading } from './createLoadingController.js';
import { productFrameLayout } from './createProductFrameLayout.js';
import { showProductTitle } from './showProductTitle.js';

/** The parts of the page the product frame shares. */
type Params = {
  body: () => Pick<HTMLElement, 'style'>;
  /** Where the product frame mounts. */
  container: () => Pick<HTMLElement, 'dataset' | 'replaceChildren'>;
  /** Takes the full-page screen over the frame down. */
  clearScreen: () => void;
  /** Ends the loading screen. */
  hideLoading: () => void;
};

/**
 * Returns the frame's surroundings: the layout, the tab title, the screens over it and, in checker builds, the panel.
 * Never throws.
 */
export function createProductFrameView({ body, container, clearScreen, hideLoading }: Params): ProductFrameView {
  return {
    attachFrame(iframe) {
      productFrameLayout.attach(iframe);
      const { style } = body();
      style.margin = '0';
      style.overflow = 'hidden';
    },
    showTitle(product) {
      showProductTitle(product);
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
        : async () => {
            const { mountViolationPanel } = await loadViolationPanelMount();
            return iframe => mountViolationPanel(iframe);
          },
  };
}

/** Where the page mounts the product frame. */
export function getProductFrameContainer(): HTMLElement {
  return document.getElementById('app') ?? document.body;
}

/** The page's frame view, over its body, screens and loading screen. */
export const productFrameView: ProductFrameView = createProductFrameView({
  body: () => document.body,
  container: getProductFrameContainer,
  clearScreen: pageScreen.clear,
  hideLoading: pageLoading.hideLoading,
});
