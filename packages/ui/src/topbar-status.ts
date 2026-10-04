// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The bar's status as attributes its module styles: `data-health` colours the
// collapsed capsule's bar, `data-action` shows its pulsing action dot. It also
// publishes the pill's box, because the popovers that drop from it are
// portalled to <body> and cannot see it.

import { chatPanelStore, totalChatUnread } from './state/chat-panel.js';
import { initNetworkHealth, networkHealthStore } from './state/network-health.js';
import { topbarStore } from './state/topbar.js';
import { needsAction } from './state/topbar-signals.js';

function publishBox(bar: HTMLElement): void {
  const root = document.documentElement;
  const box = bar.getBoundingClientRect();
  // A hidden bar (the landing page) has no box: the menus keep their own place.
  if (box.width === 0) {
    root.style.removeProperty('--topbar-inline-end');
    root.style.removeProperty('--topbar-bottom');
    return;
  }
  root.style.setProperty('--topbar-inline-end', `${String(Math.max(0, root.clientWidth - box.right))}px`);
  root.style.setProperty('--topbar-bottom', `${String(box.bottom)}px`);
}

export function bindTopbarStatus(bar: HTMLElement): () => void {
  // The bar's script runs before initTopBar (which waits for the bridge), so
  // it starts the health's online and offline listening itself. Shared and
  // idempotent, so unbinding the bar leaves it running.
  initNetworkHealth();
  const render = (): void => {
    bar.dataset['health'] = networkHealthStore.get();
    bar.toggleAttribute('data-action', needsAction(topbarStore.get(), totalChatUnread(chatPanelStore.get())));
  };
  const place = (): void => {
    publishBox(bar);
  };
  render();
  place();
  const offHealth = networkHealthStore.subscribe(render);
  const offTopbar = topbarStore.subscribe(render);
  const offChat = chatPanelStore.subscribe(render);
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place);
  observer?.observe(bar);
  window.addEventListener('resize', place);
  return () => {
    offHealth();
    offTopbar();
    offChat();
    observer?.disconnect();
    window.removeEventListener('resize', place);
  };
}

/**
 * How far the bar can still widen before its max-width, in px: the room a
 * content-sized pill gives its action group beyond its current width.
 */
export function topbarGrowRoom(): number {
  const bar = document.getElementById('topbar');
  if (bar === null) {
    return 0;
  }
  const max = Number.parseFloat(getComputedStyle(bar).maxWidth);
  return Number.isFinite(max) ? Math.max(0, max - bar.getBoundingClientRect().width) : 0;
}
