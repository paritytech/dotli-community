// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Binds the topbar's static markup to the topbar and network health stores.

import { networkHealthState } from './state/networkHealthState.js';
import { topbarState } from './state/topbarState.js';
import { pageTopbarAutoHide } from './createTopbarAutoHide.js';
import { TOPBAR_REVEAL_SHORTCUT } from './topbarRevealShortcut.js';
import { bindTopbarStatus } from './bindTopbarStatus.js';

/**
 * Binds `bar` to the topbar auto-hide, the topbar store and the network health store until the returned unbind. Throws
 * only as `bar` or the stores do.
 */
export function bindTopbar(bar: HTMLElement): () => void {
  const releaseBar = pageTopbarAutoHide.registerBar(bar);
  const unbindStatus = bindTopbarStatus(bar, networkHealthState.store);
  bar.addEventListener('mouseenter', pageTopbarAutoHide.reveal);
  bar.addEventListener('mouseleave', pageTopbarAutoHide.scheduleHide);

  function render(): void {
    const { visible, autoHide } = topbarState.get();
    bar.toggleAttribute('data-hidden', !visible);
    if (autoHide) {
      bar.setAttribute('aria-keyshortcuts', TOPBAR_REVEAL_SHORTCUT);
    } else {
      bar.removeAttribute('aria-keyshortcuts');
    }
  }
  render();
  const offTopbar = topbarState.store.subscribe(render);

  function unbind(): void {
    offTopbar();
    bar.removeEventListener('mouseenter', pageTopbarAutoHide.reveal);
    bar.removeEventListener('mouseleave', pageTopbarAutoHide.scheduleHide);
    unbindStatus();
    releaseBar();
  }

  return unbind;
}
