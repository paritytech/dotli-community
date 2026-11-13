// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The pill's box is root properties, because the popovers that drop from it are portalled to <body> and cannot see it.

import { createPillPlacement } from './createPillPlacement.js';
import { topbarMorph } from './createTopbarMorph.js';
import { getPillBox, type PillBox } from './getPillBox.js';
import { topbarState } from './state/topbarState.js';

/** Binds `bar` as the page morph's bar and publishes its box at rest, until the returned unbind. */
export function bindPillBox(bar: HTMLElement): () => void {
  const root = document.documentElement;
  const placePill = createPillPlacement({ publish: publishPillBox });
  const releaseBar = topbarMorph.setBar(bar, place);

  function publishPillBox(box: PillBox | null): void {
    // A bar with no box leaves the menus their own place.
    if (box === null) {
      root.style.removeProperty('--topbar-inline-end');
      root.style.removeProperty('--topbar-bottom');
      return;
    }
    root.style.setProperty('--topbar-inline-end', `${String(box.inlineEnd)}px`);
    root.style.setProperty('--topbar-bottom', `${String(box.bottom)}px`);
  }

  function place(): void {
    placePill(
      () => getPillBox(bar.getBoundingClientRect(), root.clientWidth),
      !topbarMorph.running() && topbarState.get().visible,
    );
  }

  place();
  const observer = new ResizeObserver(place);
  observer.observe(bar);
  window.addEventListener('resize', place);

  function unbind(): void {
    observer.disconnect();
    window.removeEventListener('resize', place);
    releaseBar();
  }

  return unbind;
}
