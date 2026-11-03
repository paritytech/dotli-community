// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import type { JSX } from '@solidjs/web';
import { RootBoundary } from '@dotli/ui';
import { useStore } from '@dotli/stores-solid';
import { topbarState } from '../state/topbarState.js';
import { TopbarReveal as Reveal } from '../components/topbar/TopbarReveal.js';
import { pageTopbarAutoHide } from '../createTopbarAutoHide.js';
import { TOPBAR_REVEAL_SHORTCUT } from '../topbarRevealShortcut.js';

/** The auto-hiding topbar's ways back, bound to the page's auto-hide. */
export function TopbarReveal(): JSX.Element {
  return (
    <RootBoundary root="island:TopbarReveal">
      <Reveal
        autoHide={useStore(topbarState.store, state => state.autoHide)}
        shortcut={TOPBAR_REVEAL_SHORTCUT}
        actions={pageTopbarAutoHide}
      />
    </RootBoundary>
  );
}
