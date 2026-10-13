// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import type { JSX } from '@solidjs/web';
import { useStore } from '@dotli/ui';
import { topbarStore } from '../state/topbar.js';
import { TopbarReveal as Reveal } from '../components/topbar/TopbarReveal.js';
import { pageTopbarAutoHide, TOPBAR_REVEAL_SHORTCUT } from '../topbar-autohide.js';

/** The auto-hiding topbar's ways back, bound to the page's auto-hide. */
export function TopbarReveal(): JSX.Element {
  return (
    <Reveal
      autoHide={useStore(topbarStore, state => state.autoHide)}
      shortcut={TOPBAR_REVEAL_SHORTCUT}
      actions={pageTopbarAutoHide}
    />
  );
}
