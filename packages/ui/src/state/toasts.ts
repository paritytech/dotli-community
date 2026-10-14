// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A countdown pauses while the tab is hidden or the stack is expanded and resumes from what was left.

import { captureException } from '@dotli/metrics';
import { createSyncStore, shallowEqual, type ReadableStore } from './create-store.js';
import type { StatusTone } from '../components/primitives/StatusDot.js';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastInput {
  text: string;
  label: string;
  onActivate?: () => void;
  icon: string;
  /** Tints the icon tile. */
  tone?: StatusTone;
  /** 0 is persistent. */
  dismissMs: number;
  onDismiss?: () => void;
  action?: ToastAction;
}

export interface ToastEntry {
  id: number;
  text: string;
  label: string;
  onActivate?: () => void;
  icon: string;
  tone: StatusTone;
  action?: ToastAction;
  leaving: boolean;
}

export interface ToastsState {
  /** Newest last. */
  items: readonly ToastEntry[];
  expanded: boolean;
}

interface Timer {
  remaining: number;
  startedAt: number;
  handle: ReturnType<typeof setTimeout> | undefined;
  onDismiss: (() => void) | undefined;
}

const INITIAL: ToastsState = { items: [], expanded: false };
const toasts = createSyncStore<ToastsState>('toasts', INITIAL, { equals: shallowEqual });
export const toastsStore: ReadableStore<ToastsState> = toasts;

const timers = new Map<number, Timer>();
let nextId = 0;
let visibilityBound = false;

function shouldPause(): boolean {
  return toasts.get().expanded || document.visibilityState !== 'visible';
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

function bindVisibility(): void {
  if (visibilityBound) {
    return;
  }
  visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      resumeAll();
    } else {
      pauseAll();
    }
  });
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
  bindVisibility();
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
    icon: input.icon,
    tone: input.tone ?? 'info',
    leaving: false,
  };
  if (input.onActivate !== undefined) {
    entry.onActivate = input.onActivate;
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

export function resetToastsForTests(): void {
  clearToasts();
  nextId = 0;
}
