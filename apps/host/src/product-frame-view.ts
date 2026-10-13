// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The runtime's product frame view answered with the page's frame layout and app roots, for the host to hand to the
// bridge.

import type { ProductFrameView } from '@dotli/host-runtime';
import { disposeAppRoot } from '@dotli/ui-core';
import { loadViolationPanelMount } from './lazy.js';
import { attachProductFrame } from './product-frame-layout.js';
import { showProductTitle } from './product-title.js';

/** The parts of the page the product frame shares. Read at each use, so building the view reads no DOM. */
export interface FramePage {
  /** The frame's container, `#app`. */
  container: () => Pick<ParentNode, 'querySelectorAll'>;
  body: () => Pick<HTMLElement, 'style'>;
}

/** The frame's surroundings: the layout, the tab title, the app roots over it and, in checker builds, the panel. */
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
      disposeAppRoot('page');
      if (loading) {
        disposeAppRoot('loading');
      }
      // An error page written after an earlier activation is the one untracked child a rebuild must clear.
      for (const stray of page.container().querySelectorAll(':scope > [data-error-page]')) {
        stray.remove();
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
