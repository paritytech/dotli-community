// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Publishes the pill's box as root properties, because the popovers that drop from it are portalled to
// <body> and cannot see it.

import type { ReadableStore } from '@dotli/shared';
import { isPhoneViewport } from '@dotli/ui';
import { topbarStore } from './state/topbar.js';
import type { NetworkHealth } from './network-verdict.js';
import { chatPanelStore, totalChatUnread } from './state/chat-panel.js';
import { needsAction } from './state/topbar-signals.js';

/** Counts the bar's own running transitions, so what is laid out against its box waits for the morph to end. */
export interface MorphCount {
  start: () => void;
  /** True when this ended the last running morph. An end with none running is ignored. */
  end: () => boolean;
  running: () => boolean;
  reset: () => void;
}

/**
 * `transitionsRunning` answers whether any of the bar's transitions still run, or undefined where the engine cannot
 * say. An engine may drop a transition without its end or cancel event, so a count with none running is cleared
 * rather than freezing layout for good.
 */
export function createMorphCount(transitionsRunning: () => boolean | undefined): MorphCount {
  let morphs = 0;
  return {
    start: () => {
      morphs += 1;
    },
    end: () => {
      if (morphs === 0) {
        return false;
      }
      morphs -= 1;
      return morphs === 0;
    },
    running: () => {
      if (morphs > 0 && transitionsRunning() === false) {
        morphs = 0;
      }
      return morphs > 0;
    },
    reset: () => {
      morphs = 0;
    },
  };
}

/** Where the pill ends, in px from the viewport's inline end and top. */
export interface PillBox {
  inlineEnd: number;
  bottom: number;
}

/** Null for a bar that is not laid out, which has no box. */
export function pillBox(rect: Pick<DOMRect, 'right' | 'bottom' | 'width'>, viewportWidth: number): PillBox | null {
  if (rect.width === 0) {
    return null;
  }
  return { inlineEnd: Math.round(Math.max(0, viewportWidth - rect.right)), bottom: Math.round(rect.bottom) };
}

/**
 * Publishes the pill's box at rest. A folded or morphing bar keeps the box it published open, which is the one it
 * reveals to, and is not measured. An unchanged box is not written again.
 */
export function createPillPlacement(
  publish: (box: PillBox | null) => void,
): (measure: () => PillBox | null, atRest: boolean) => void {
  // As last published. Undefined until the first one.
  let last: PillBox | null | undefined;
  return (measure, atRest) => {
    if (!atRest) {
      return;
    }
    const box = measure();
    const same =
      last !== undefined &&
      (box === null || last === null ? box === last : box.inlineEnd === last.inlineEnd && box.bottom === last.bottom);
    if (same) {
      return;
    }
    last = box;
    publish(box);
  };
}

/** What the capsule shows of the page's state. */
export interface CapsuleStatus {
  /** The tone of the page's network health. */
  tone: NetworkHealth;
  /** The capsule leads with the action dot. */
  action: boolean;
  /** The capsule's colour is not announced, so going offline is said in words. */
  announcement: string;
}

export function capsuleStatus(health: NetworkHealth, action: boolean, online: boolean): CapsuleStatus {
  return { tone: health, action, announcement: online ? '' : 'You are offline' };
}

/** Whether the page waits on the user, a prompt or unread chat, so the capsule leads with the action dot. */
export function pageNeedsAction(): boolean {
  return needsAction(topbarStore.get(), totalChatUnread(chatPanelStore.get()));
}

// A fold or reveal morphs the bar's box every frame, so what is laid out against it is read once the
// morph ends.
const morphEnds = new Set<() => void>();
let morphBar: HTMLElement | null = null;
const morphs = createMorphCount(() =>
  morphBar !== null && typeof morphBar.getAnimations === 'function'
    ? morphBar.getAnimations().some(animation => 'transitionProperty' in animation)
    : undefined,
);

function morphing(): boolean {
  return morphs.running();
}

/** The bar's own morph: a fold or reveal that resizes the row every frame until it ends. */
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

/** `health` is the page's network health, which the capsule takes its colour from. */
export function bindTopbarStatus(bar: HTMLElement, health: ReadableStore<NetworkHealth>): () => void {
  morphBar = bar;
  const offline = bar.querySelector('#topbar-offline');
  const render = (): void => {
    const status = capsuleStatus(health.get(), pageNeedsAction(), navigator.onLine);
    bar.dataset['tone'] = status.tone;
    bar.toggleAttribute('data-action', status.action);
    if (offline !== null && offline.textContent !== status.announcement) {
      offline.textContent = status.announcement;
    }
  };
  const root = document.documentElement;
  const publish = createPillPlacement(box => {
    // A bar with no box leaves the menus their own place.
    if (box === null) {
      root.style.removeProperty('--topbar-inline-end');
      root.style.removeProperty('--topbar-bottom');
      return;
    }
    root.style.setProperty('--topbar-inline-end', `${String(box.inlineEnd)}px`);
    root.style.setProperty('--topbar-bottom', `${String(box.bottom)}px`);
  });
  const place = (): void => {
    publish(() => pillBox(bar.getBoundingClientRect(), root.clientWidth), !morphing() && topbarStore.get().visible);
  };
  // Children's transitions bubble up here and are not the bar's box.
  const onMorphRun = (event: Event): void => {
    if (event.target === bar) {
      morphs.start();
    }
  };
  const onMorphEnd = (event: Event): void => {
    if (event.target === bar && morphs.end()) {
      place();
      for (const listener of [...morphEnds]) {
        listener();
      }
    }
  };
  render();
  place();
  const offHealth = health.subscribe(render);
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
    morphs.reset();
    if (morphBar === bar) {
      morphBar = null;
    }
  };
}

/**
 * The open pill's max width less the rest of its row, the group's layout parent. Neither changes while the pill morphs,
 * even where the morph animates the pill's own max-width, so items never pop in and out during a reveal.
 */
export function topbarActionRoom(group: HTMLElement, row: HTMLElement | null): number | undefined {
  if (isPhoneViewport()) {
    return group.clientWidth;
  }
  const bar = document.getElementById('topbar');
  if (bar === null || row === null) {
    return undefined;
  }
  return actionRoom(
    Number.parseFloat(getComputedStyle(bar).getPropertyValue('--topbar-max-width')),
    row.scrollWidth,
    group.getBoundingClientRect().width,
  );
}

/** The pill's max width less what the rest of its row takes, or undefined when the pill sets no max width. */
export function actionRoom(pillMaxWidth: number, rowWidth: number, groupWidth: number): number | undefined {
  return Number.isFinite(pillMaxWidth) ? pillMaxWidth - (rowWidth - groupWidth) : undefined;
}
