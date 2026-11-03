// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Publishes the pill's box as root properties, because the popovers that drop from it are portalled to
// <body> and cannot see it.

import type { ReadableAtom } from 'nanostores';
import { createPillPlacement } from './createPillPlacement.js';
import { topbarMorph, type TopbarMorph } from './createTopbarMorph.js';
import { getCapsuleStatus } from './getCapsuleStatus.js';
import { getPillBox, type PillBox } from './getPillBox.js';
import { pageActionNeeded } from './pageActionNeeded.js';
import type { NetworkHealth } from './networkVerdict.js';
import { topbarState } from './state/topbarState.js';

type Params = {
  /** The bar's own morph, the page's unless given. */
  morph?: TopbarMorph;
};

/**
 * Binds the capsule's tone, action dot and offline line to the page's state, and publishes the pill's box at rest.
 * `health` is the page's network health, which the capsule takes its colour from. Returns the unbind. Never throws.
 */
export function bindTopbarStatus(
  bar: HTMLElement,
  health: ReadableAtom<NetworkHealth>,
  { morph = topbarMorph }: Params = {},
): () => void {
  const offline = bar.querySelector('#topbar-offline');
  const root = document.documentElement;
  const publish = createPillPlacement({ publish: publishPillBox });
  const releaseBar = morph.setBar(bar, place);

  function render(): void {
    const status = getCapsuleStatus({
      health: health.get(),
      action: pageActionNeeded.get(),
      online: navigator.onLine,
    });
    bar.dataset['tone'] = status.tone;
    bar.toggleAttribute('data-action', status.action);
    if (offline !== null && offline.textContent !== status.announcement) {
      offline.textContent = status.announcement;
    }
  }

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
    publish(
      () => getPillBox(bar.getBoundingClientRect(), root.clientWidth),
      !morph.running() && topbarState.get().visible,
    );
  }

  render();
  place();
  const offHealth = health.listen(render);
  const offAction = pageActionNeeded.listen(render);
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place);
  observer?.observe(bar);
  window.addEventListener('resize', place);
  window.addEventListener('online', render);
  window.addEventListener('offline', render);

  function unbind(): void {
    offHealth();
    offAction();
    observer?.disconnect();
    window.removeEventListener('resize', place);
    window.removeEventListener('online', render);
    window.removeEventListener('offline', render);
    releaseBar();
  }

  return unbind;
}
