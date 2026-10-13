// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The topbar's static markup comes from Topbar.astro. This binds it to the topbar and network health stores.

import { networkHealthStore } from './state/network-health.js';
import { topbarStore } from './state/topbar.js';
import { registerTopbarElement, revealTopbar, scheduleTopbarHide, TOPBAR_REVEAL_SHORTCUT } from './topbar-autohide.js';
import { bindTopbarStatus } from './topbar-status.js';

export function bindTopbar(bar: HTMLElement): void {
  registerTopbarElement(bar);
  bindTopbarStatus(bar, networkHealthStore);
  bar.addEventListener('mouseenter', revealTopbar);
  bar.addEventListener('mouseleave', scheduleTopbarHide);

  const render = (): void => {
    const { visible, autoHide } = topbarStore.get();
    bar.toggleAttribute('data-hidden', !visible);
    if (autoHide) {
      bar.setAttribute('aria-keyshortcuts', TOPBAR_REVEAL_SHORTCUT);
    } else {
      bar.removeAttribute('aria-keyshortcuts');
    }
  };
  render();
  topbarStore.subscribe(render);
}
