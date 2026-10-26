// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A countdown runs only while a view shows the toasts. It pauses while the tab is hidden or the stack is expanded and
// resumes from what was left.

import { captureException } from '@dotli/metrics';
import { createSyncStore, registerStoreStateReset, shallowEqual, type ReadableStore } from '@dotli/shared';
import type { StatusTone } from '../status-tone.js';
import type { Component } from 'solid-js';
import type { IconProps } from '../../components/icons/icon-props.js';

export type ToastAction = {
  label: string;
  onClick: () => void;
};

export type ToastInput = {
  text: string;
  label: string;
  deeplink?: string;
  /** Drawn in the toast's tile, which sizes it and colors it by tone. Its tone's icon without one. */
  icon?: Component<IconProps>;
  /** Tints the icon tile. */
  tone?: StatusTone;
  /** 0 is persistent. */
  dismissMs: number;
  onDismiss?: () => void;
  action?: ToastAction;
};

export type ToastEntry = {
  id: number;
  text: string;
  label: string;
  deeplink?: string;
  icon?: Component<IconProps>;
  tone: StatusTone;
  action?: ToastAction;
  leaving: boolean;
};

export type ToastsState = {
  /** Newest last. */
  items: readonly ToastEntry[];
  expanded: boolean;
};

type Timer = {
  remaining: number;
  startedAt: number;
  handle: ReturnType<typeof setTimeout> | undefined;
  onDismiss: (() => void) | undefined;
};

const INITIAL: ToastsState = { items: [], expanded: false };
const toasts = createSyncStore<ToastsState>('toasts', INITIAL, { equals: shallowEqual });
export const toastsStore: ReadableStore<ToastsState> = toasts;

/** The page whose visibility pauses the countdowns. */
export type ToastPage = {
  readonly visibilityState: DocumentVisibilityState;
} & EventTarget;

const timers = new Map<number, Timer>();
let nextId = 0;
let views = 0;
// Bumped by a reset, so a view mounted before it releases nothing when it unmounts after it.
let viewGeneration = 0;
let page: ToastPage | undefined;
// Removes the bound page's listener, so a rebind or a reset never leaves one behind.
let pageBinding: AbortController | undefined;

function currentPage(): ToastPage {
  if (page === undefined) {
    bindToastPage(document);
    return document;
  }
  return page;
}

function shouldPause(): boolean {
  return views === 0 || toasts.get().expanded || currentPage().visibilityState !== 'visible';
}

function start(id: number): void {
  const timer = timers.get(id);
  if (timer === undefined || timer.remaining <= 0 || timer.handle !== undefined || shouldPause()) {
    return;
  }
  timer.startedAt = Date.now();
  timer.handle = setTimeout(() => {
    timer.handle = undefined;
    dismissToast(id);
  }, timer.remaining);
}

function pause(id: number): void {
  const timer = timers.get(id);
  if (timer?.handle === undefined) {
    return;
  }
  clearTimeout(timer.handle);
  timer.handle = undefined;
  timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.startedAt));
}

function pauseAll(): void {
  for (const id of timers.keys()) {
    pause(id);
  }
}

function resumeAll(): void {
  if (shouldPause()) {
    return;
  }
  for (const id of timers.keys()) {
    start(id);
  }
}

function unbindToastPage(): void {
  pageBinding?.abort();
  pageBinding = undefined;
  page = undefined;
}

/** Without a call, the document, bound on the first toast. Binding the bound page again does nothing. */
export function bindToastPage(source: ToastPage): void {
  if (page === source) {
    return;
  }
  unbindToastPage();
  const binding = new AbortController();
  pageBinding = binding;
  page = source;
  source.addEventListener(
    'visibilitychange',
    () => {
      if (source.visibilityState === 'visible') {
        resumeAll();
      } else {
        pauseAll();
      }
    },
    { signal: binding.signal },
  );
}

/** A view calls it on mount and the returned function on unmount. The first view starts the countdowns, the last pauses them. */
export function showToasts(): () => void {
  views++;
  if (views === 1) {
    resumeAll();
  }
  const generation = viewGeneration;
  let shown = true;
  return () => {
    if (!shown || generation !== viewGeneration) {
      return;
    }
    shown = false;
    views--;
    if (views === 0) {
      pauseAll();
    }
  };
}

function finishTimer(id: number): void {
  const timer = timers.get(id);
  pause(id);
  timers.delete(id);
  try {
    timer?.onDismiss?.();
  } catch (err) {
    captureException(err, { flow: 'ui', step: 'toast_dismiss', tags: { kind: 'toast_on_dismiss_error' } });
  }
}

export function pushToast(input: ToastInput): number {
  currentPage();
  const id = nextId++;
  timers.set(id, {
    remaining: input.dismissMs,
    startedAt: 0,
    handle: undefined,
    onDismiss: input.onDismiss,
  });
  const entry: ToastEntry = {
    id,
    text: input.text,
    label: input.label,
    tone: input.tone ?? 'info',
    leaving: false,
  };
  if (input.deeplink !== undefined) {
    entry.deeplink = input.deeplink;
  }
  if (input.icon !== undefined) {
    entry.icon = input.icon;
  }
  if (input.action !== undefined) {
    entry.action = input.action;
  }
  const state = toasts.get();
  toasts.set({ ...state, items: [...state.items, entry] });
  start(id);
  return id;
}

export function dismissToast(id: number): void {
  const state = toasts.get();
  const entry = state.items.find(t => t.id === id);
  if (entry === undefined || entry.leaving) {
    return;
  }
  finishTimer(id);
  toasts.set({
    ...state,
    items: state.items.map(t => (t.id === id ? { ...t, leaving: true } : t)),
  });
}

/** Called once the exit animation has finished. */
export function removeToast(id: number): void {
  const state = toasts.get();
  if (!state.items.some(t => t.id === id)) {
    return;
  }
  timers.delete(id);
  const items = state.items.filter(t => t.id !== id);
  const collapse = state.expanded && items.length <= 1;
  toasts.set({ items, expanded: collapse ? false : state.expanded });
  if (collapse) {
    resumeAll();
  }
}

export function dismissAllToasts(): void {
  const state = toasts.get();
  const active = state.items.filter(t => !t.leaving);
  if (active.length === 0) {
    return;
  }
  pauseAll();
  for (const t of active) {
    finishTimer(t.id);
  }
  toasts.set({
    ...state,
    items: state.items.map(t => (t.leaving ? t : { ...t, leaving: true })),
  });
}

export function setToastsExpanded(expanded: boolean): void {
  const state = toasts.get();
  if (state.expanded === expanded) {
    return;
  }
  toasts.set({ ...state, expanded });
  if (expanded) {
    pauseAll();
  } else {
    resumeAll();
  }
}

/** Skips callbacks, for when overlays cannot render. */
export function clearToasts(): void {
  pauseAll();
  timers.clear();
  toasts.set(INITIAL);
}

registerStoreStateReset(() => {
  clearToasts();
  nextId = 0;
  views = 0;
  viewGeneration++;
  unbindToastPage();
});
