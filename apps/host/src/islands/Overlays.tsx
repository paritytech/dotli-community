// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import type { JSX } from '@solidjs/web';
import { ModalFocusFallback, Overlays as PageOverlays, refuseModals, RootBoundary } from '@dotli/ui';
import { productFrameFocus } from '../product-frame-layout.js';

/**
 * The page's toasts and dialogs. Its stores hold what boot queued before it hydrated, so that shows once it does. A
 * broken overlay refuses the product's prompts rather than leaving them waiting. Every dialog here hands focus back to
 * the product frame when the element it came from is gone, as the topbar's do.
 */
export function Overlays(): JSX.Element {
  return (
    <RootBoundary root="island:Overlays" onBroken={refuseModals}>
      <ModalFocusFallback value={productFrameFocus}>
        <PageOverlays />
      </ModalFocusFallback>
    </RootBoundary>
  );
}
