// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The bar's status as attributes its module styles: `data-tone`, the network
// health, colours the collapsed capsule's bar, `data-action` shows its
// pulsing action dot. It also publishes the pill's box, because the popovers
// that drop from it are portalled to <body> and cannot see it.

import { layoutParent } from './components/shell/topbar/fit.js';
import { isPhoneViewport } from './phone-viewport.js';
import { chatPanelStore, totalChatUnread } from './state/chat-panel.js';
import { initNetworkHealth, networkHealthStore } from './state/network-health.js';
import { topbarStore } from './state/topbar.js';
import { needsAction } from './state/topbar-signals.js';

// A fold or a reveal morphs the bar's box every frame for --dur-morph. What
// is laid out against that box (the published box, the action group's room)
// is read at rest, once the morph ends: an open surface keeps the bar from
// folding, so none drops from a morphing bar.
let morphs = 0;
const morphEnds = new Set<() => void>();
/** The bound bar, whose own transitions say whether a morph still runs. */
let morphBar: HTMLElement | null = null;

/**
 * Whether the bar is mid-morph. The count alone could stick: an engine may
 * drop a transition without its end or cancel event, and a stuck count would
 * freeze the published box and the action group's room for good. So a count
 * with none of the bar's own transitions running is cleared.
 */
function morphing(): boolean {
  if (
    morphs > 0 &&
    morphBar !== null &&
    typeof morphBar.getAnimations === 'function' &&
    !morphBar.getAnimations().some(animation => 'transitionProperty' in animation)
  ) {
    morphs = 0;
  }
  return morphs > 0;
}

/** The bar's fold and reveal morph, for what is laid out against its box. */
export interface TopbarMorph {
  running: () => boolean;
  /** Calls `listener` each time a morph ends. Returns the unsubscribe. */
  onEnd: (listener: () => void) => () => void;
}

export const topbarMorph: TopbarMorph = {
  running: morphing,
  onEnd: listener => {
    morphEnds.add(listener);
    return () => {
      morphEnds.delete(listener);
    };
  },
};

export function bindTopbarStatus(bar: HTMLElement): () => void {
  // The bar's script runs before initTopBar (which waits for the bridge), so
  // it starts the health's online and offline listening itself. Shared and
  // idempotent, so unbinding the bar leaves it running.
  initNetworkHealth();
  morphBar = bar;
  // The capsule's colour is not announced, so going offline is said in words.
  const offline = bar.querySelector('#topbar-offline');
  const render = (): void => {
    bar.dataset['tone'] = networkHealthStore.get();
    bar.toggleAttribute('data-action', needsAction(topbarStore.get(), totalChatUnread(chatPanelStore.get())));
    const words = navigator.onLine ? '' : 'You are offline';
    if (offline !== null && offline.textContent !== words) {
      offline.textContent = words;
    }
  };
  const root = document.documentElement;
  // As last written, so an unchanged box leaves the root's style alone.
  // Undefined until the first write, null once removed.
  let inlineEnd: number | null | undefined;
  let bottom: number | null | undefined;
  const place = (): void => {
    // Folded, the bar is not where a surface drops from, and the box it
    // published open is the one it reveals to.
    if (morphing() || bar.hasAttribute('data-hidden')) {
      return;
    }
    const box = bar.getBoundingClientRect();
    // A hidden bar (the landing page) has no box: the menus keep their own place.
    if (box.width === 0) {
      if (inlineEnd !== null) {
        root.style.removeProperty('--topbar-inline-end');
        root.style.removeProperty('--topbar-bottom');
        inlineEnd = null;
        bottom = null;
      }
      return;
    }
    const nextEnd = Math.round(Math.max(0, root.clientWidth - box.right));
    const nextBottom = Math.round(box.bottom);
    if (nextEnd !== inlineEnd) {
      root.style.setProperty('--topbar-inline-end', `${String(nextEnd)}px`);
      inlineEnd = nextEnd;
    }
    if (nextBottom !== bottom) {
      root.style.setProperty('--topbar-bottom', `${String(nextBottom)}px`);
      bottom = nextBottom;
    }
  };
  // Each of the bar's own transitions runs once and then ends or is
  // cancelled. Its children's bubble up here and are not its box.
  const onMorphRun = (event: Event): void => {
    if (event.target === bar) {
      morphs += 1;
    }
  };
  const onMorphEnd = (event: Event): void => {
    if (event.target !== bar || morphs === 0) {
      return;
    }
    morphs -= 1;
    if (morphs === 0) {
      place();
      for (const listener of [...morphEnds]) {
        listener();
      }
    }
  };
  render();
  place();
  const offHealth = networkHealthStore.subscribe(render);
  const offTopbar = topbarStore.subscribe(render);
  const offChat = chatPanelStore.subscribe(render);
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place);
  observer?.observe(bar);
  window.addEventListener('resize', place);
  window.addEventListener('online', render);
  window.addEventListener('offline', render);
  bar.addEventListener('transitionrun', onMorphRun);
  bar.addEventListener('transitionend', onMorphEnd);
  bar.addEventListener('transitioncancel', onMorphEnd);
  return () => {
    offHealth();
    offTopbar();
    offChat();
    observer?.disconnect();
    window.removeEventListener('resize', place);
    window.removeEventListener('online', render);
    window.removeEventListener('offline', render);
    bar.removeEventListener('transitionrun', onMorphRun);
    bar.removeEventListener('transitionend', onMorphEnd);
    bar.removeEventListener('transitioncancel', onMorphEnd);
    morphs = 0;
    if (morphBar === bar) {
      morphBar = null;
    }
  };
}

/**
 * The room the action group has in the pill: the pill's max width less
 * everything else in its row, with the address counted at its minimum. The
 * same at rest and while the pill morphs (when the address is squeezed), so
 * items never pop in and out during a reveal. Undefined without the bar.
 * On a phone the bar has no address and the group fills it after the logo,
 * so its own width is its room.
 */
export function topbarActionRoom(group: HTMLElement, row = layoutParent(group)): number | undefined {
  if (isPhoneViewport()) {
    return group.clientWidth;
  }
  const bar = document.getElementById('topbar');
  if (bar === null || row === null) {
    return undefined;
  }
  const max = Number.parseFloat(getComputedStyle(bar).maxWidth);
  if (!Number.isFinite(max)) {
    return undefined;
  }
  const url = document.getElementById('topbar-url');
  let urlSlack = 0;
  if (url !== null && url.hidden !== true) {
    const min = Number.parseFloat(getComputedStyle(url).minWidth);
    urlSlack = Math.max(0, url.getBoundingClientRect().width - (Number.isFinite(min) ? min : 0));
  }
  return max - (row.scrollWidth - group.getBoundingClientRect().width) + urlSlack;
}
