// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The topbar's static markup comes from Topbar.astro. This binds it to the topbar and network health stores.

import { networkHealthState } from './state/networkHealthState.js';
import { topbarState } from './state/topbarState.js';
import { registerTopbarElement, revealTopbar, scheduleTopbarHide, TOPBAR_REVEAL_SHORTCUT } from './topbarAutohide.js';
import { bindTopbarStatus } from './topbarStatus.js';

export function bindTopbar(bar: HTMLElement): void {
  registerTopbarElement(bar);
  bindTopbarStatus(bar, networkHealthState.store);
  bar.addEventListener('mouseenter', revealTopbar);
  bar.addEventListener('mouseleave', scheduleTopbarHide);

  const render = (): void => {
    const { visible, autoHide } = topbarState.get();
    bar.toggleAttribute('data-hidden', !visible);
    if (autoHide) {
      bar.setAttribute('aria-keyshortcuts', TOPBAR_REVEAL_SHORTCUT);
    } else {
      bar.removeAttribute('aria-keyshortcuts');
    }
  };
  render();
  topbarState.store.subscribe(render);
}
