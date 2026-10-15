// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import type { JSX } from '@solidjs/web';
import { LayerTracker, RootBoundary, useStore } from '@dotli/ui';
import { UrlPillShield as Shield } from '../components/shield/UrlPillShield.js';
import { registerTopbarSurface } from '../state/topbar-surfaces.js';
import { pillShield, urlPillStore } from '../state/url-pill.js';

/**
 * The URL pill's verification shield, bound to the url-pill store that bindUrlPill renders the rest of the pill from.
 * The shield's tooltip keeps the auto-hiding bar up while open.
 */
export function UrlPillShield(): JSX.Element {
  return (
    <RootBoundary root="island:UrlPillShield">
      <LayerTracker value={registerTopbarSurface}>
        <Shield shield={useStore(urlPillStore, pillShield)} />
      </LayerTracker>
    </RootBoundary>
  );
}
