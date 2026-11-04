// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import type { JSX } from '@solidjs/web';
import { LayerTracker, ModalFocusFallback, RootBoundary } from '@dotli/ui';
import { useStore } from '@dotli/stores-solid';
import { ProductButton as Button } from '../components/productCard/ProductButton.js';
import { productFrameLayout } from '../createProductFrameLayout.js';
import { productCardState } from '../state/productCardState.js';
import { productCardView } from '../state/productCardView.js';
import { topbarSurfaces } from '../state/topbarSurfaces.js';

/**
 * The product button and its sheet. Opening the sheet starts the author read, and the open sheet keeps the
 * auto-hiding bar up.
 */
export function ProductButton(): JSX.Element {
  return (
    <RootBoundary root="island:ProductButton">
      <LayerTracker value={topbarSurfaces.register}>
        <ModalFocusFallback value={productFrameLayout.getFocusFallback}>
          <Button
            card={useStore(productCardView, { initial: null })}
            onCardShow={() => {
              void productCardState.loadAuthor();
            }}
            homeUrl={import.meta.env.VITE_APP_URL ?? '/'}
          />
        </ModalFocusFallback>
      </LayerTracker>
    </RootBoundary>
  );
}
