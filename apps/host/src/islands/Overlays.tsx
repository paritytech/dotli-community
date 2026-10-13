// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import type { JSX } from '@solidjs/web';
import { Overlays as PageOverlays } from '@dotli/ui';
import { IslandBoundary } from './IslandBoundary.js';

/** The page's toasts and dialogs. Its stores hold what boot queued before it hydrated, so that shows once it does. */
export function Overlays(): JSX.Element {
  return (
    <IslandBoundary root="island:Overlays">
      <PageOverlays />
    </IslandBoundary>
  );
}
