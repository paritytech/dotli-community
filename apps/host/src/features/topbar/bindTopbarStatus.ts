// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReadableAtom } from 'nanostores';
import { pageActionNeeded } from './pageActionNeeded.js';
import { isNetworkOffline, type NetworkHealth } from '../network/index.js';

/** What the offline line says, since the capsule's colour is not announced. */
const OFFLINE_ANNOUNCEMENT = 'You are offline';

/**
 * Binds the capsule's tone, action dot and offline line to the page's state. `health` is the page's network health,
 * which the capsule takes its colour and offline line from. Returns the unbind.
 */
export function bindTopbarStatus(bar: HTMLElement, health: ReadableAtom<NetworkHealth>): () => void {
  const offline = bar.querySelector('#topbar-offline');

  function render(): void {
    bar.dataset['tone'] = health.get();
    bar.toggleAttribute('data-action', pageActionNeeded.get());
    const announcement = isNetworkOffline(health.get()) ? OFFLINE_ANNOUNCEMENT : '';
    // The line is a live region, so writing the same words again would announce them again.
    if (offline !== null && offline.textContent !== announcement) {
      offline.textContent = announcement;
    }
  }

  render();
  const offHealth = health.listen(render);
  const offAction = pageActionNeeded.listen(render);

  function unbind(): void {
    offHealth();
    offAction();
  }

  return unbind;
}
