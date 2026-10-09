// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Publishes the pill's box as root properties, because the popovers that drop from it are portalled to
// <body> and cannot see it.

import { layoutParent } from './components/shell/topbar/fit.js';
import { isPhoneViewport } from './phone-viewport.js';
import { chatPanelStore, totalChatUnread } from './state/chat-panel.js';
import { initNetworkHealth, networkHealthStore } from './state/network-health.js';
import { topbarStore } from './state/topbar.js';
import { needsAction } from './state/topbar-signals.js';

// A fold or reveal morphs the bar's box every frame, so what is laid out against it is read once the
// morph ends.
let morphs = 0;
const morphEnds = new Set<() => void>();
let morphBar: HTMLElement | null = null;

/**
 * An engine may drop a transition without its end or cancel event, so a count with none of the bar's
 * transitions running is cleared rather than freezing layout for good.
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

export interface TopbarMorph {
  running: () => boolean;
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
  // The bar binds before initTopBar runs. Idempotent and shared, so unbinding leaves it running.
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
  // As last written, so an unchanged box leaves the root's style alone. Null once removed.
  let inlineEnd: number | null | undefined;
  let bottom: number | null | undefined;
  const place = (): void => {
    // A folded bar keeps the box it published open, which is the one it reveals to.
    if (morphing() || bar.hasAttribute('data-hidden')) {
      return;
    }
    const box = bar.getBoundingClientRect();
    // A hidden bar (the landing page) has no box, so the menus keep their own place.
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
  // Children's transitions bubble up here and are not the bar's box.
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
 * The pill's max width less the rest of its row. Nothing in the row shrinks, so that holds while the pill morphs and
 * items never pop in and out during a reveal.
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
  return max - (row.scrollWidth - group.getBoundingClientRect().width);
}
