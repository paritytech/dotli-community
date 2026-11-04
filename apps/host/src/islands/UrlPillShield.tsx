// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import type { JSX } from '@solidjs/web';
import { LayerTracker, RootBoundary } from '@dotli/ui';
import { useStore } from '@dotli/stores-solid';
import { UrlPillShield as Shield } from '../components/shield/UrlPillShield.js';
import { productCardState } from '../state/productCardState.js';
import { productCardView } from '../state/productCardView.js';
import { topbarSurfaces } from '../state/topbarSurfaces.js';
import { urlPillState } from '../state/urlPillState.js';

/**
 * The URL pill's verification shield and its product card. Opening the card starts the author read, and the open card
 * keeps the auto-hiding bar up.
 */
export function UrlPillShield(): JSX.Element {
  return (
    <RootBoundary root="island:UrlPillShield">
      <LayerTracker value={topbarSurfaces.register}>
        <Shield
          shield={useStore(urlPillState.store, urlPillState.getPillShield)}
          card={useStore(productCardView, { initial: null })}
          onCardShow={() => {
            void productCardState.loadAuthor();
          }}
        />
      </LayerTracker>
    </RootBoundary>
  );
}
