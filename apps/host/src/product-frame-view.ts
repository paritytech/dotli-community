// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The runtime's product frame view answered with the page's frame layout, screens and loading screen, for the host to
// hand to the bridge.

import type { ProductFrameView } from '@dotli/host-runtime';
import { loadViolationPanelMount } from './lazy.js';
import { attachProductFrame } from './product-frame-layout.js';
import { showProductTitle } from './product-title.js';

/** The parts of the page the product frame shares. */
export interface FramePage {
  body: () => Pick<HTMLElement, 'style'>;
  /** Takes the full-page screen over the frame down. */
  clearScreen: () => void;
  /** Ends the loading screen. */
  hideLoading: () => void;
}

/** The frame's surroundings: the layout, the tab title, the screens over it and, in checker builds, the panel. */
export function createProductFrameView(page: FramePage): ProductFrameView {
  return {
    attachFrame: iframe => {
      attachProductFrame(iframe);
      const { style } = page.body();
      style.margin = '0';
      style.overflow = 'hidden';
    },
    showTitle: product => {
      showProductTitle(product);
    },
    clearScreens: ({ loading }) => {
      page.clearScreen();
      if (loading) {
        page.hideLoading();
      }
    },
    // Behind the compile-time flag, so other builds drop the panel's chunk.
    loadCheckerPanel:
      import.meta.env.VITE_SANDBOX_CHECKER === undefined
        ? undefined
        : async () => {
            const { mountViolationPanel } = await loadViolationPanelMount();
            return iframe => mountViolationPanel(iframe);
          },
  };
}
