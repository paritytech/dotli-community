// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A countdown runs only while a view shows the toasts. It pauses while the tab is hidden or the stack is expanded and
// resumes from what was left.

import { reportListener } from '@dotli/metrics';
import {
  createSyncStore,
  isShallowEqual,
  realTimers,
  registerStoreStateReset,
  type ReadableStore,
  type Timers,
} from '@dotli/shared';
import type { StatusTone } from '../statusTone.js';
import type { Component } from 'solid-js';
import type { IconProps } from '../../components/icons/iconProps.js';

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

/** The page whose visibility pauses the countdowns. */
export type ToastPage = {
  readonly visibilityState: DocumentVisibilityState;
} & EventTarget;

type Params = {
  /** The page whose visibility pauses the countdowns. The document without one, read on the first `show` or `push`. */
  page?: ToastPage | undefined;
  /** The clock and timers the countdowns run on. */
  timers?: Timers | undefined;
};

type Countdown = {
  remaining: number;
  startedAt: number;
  handle: unknown;
  onDismiss: (() => void) | undefined;
};

const INITIAL: ToastsState = { items: [], expanded: false };

const reportDismissError = reportListener('ui', 'toast.dismiss');

/**
 * Builds a toast stack whose countdowns run on `timers` and pause with `page`. Building one reads neither the page nor
 * the clock.
 */
export function createToasts({ page, timers = realTimers }: Params = {}) {
  const state = createSyncStore<ToastsState>({ name: 'toasts', initial: INITIAL, equals: isShallowEqual });
  const store: ReadableStore<ToastsState> = state;
  const countdowns = new Map<number, Countdown>();
  let nextId = 0;
  let views = 0;
  // Bumped by a reset, so a view mounted before it releases nothing when it unmounts after it.
  let viewGeneration = 0;
  let bound: ToastPage | undefined;
  // Removes the bound page's listener, so a reset never leaves one behind.
  let pageBinding: AbortController | undefined;

  registerStoreStateReset(resetState);

  return {
    /** The toasts on screen and whether the stack is expanded. */
    store,
    /**
     * A view calls it on mount and the returned function on unmount. The first view starts the countdowns, the last
     * pauses them. The returned function releases once, and nothing after a reset. Never throws.
     */
    show,
    /** Adds a toast as the newest and returns its id. Its countdown starts while a view shows the stack. Never throws. */
    push,
    /**
     * Marks the toast leaving and calls its `onDismiss` once, reporting a throw from it. A toast unknown or already
     * leaving is ignored. Never throws.
     */
    dismiss,
    /** Drops the toast once its exit animation has finished. An unknown id is ignored. Never throws. */
    remove,
    /** Marks every toast leaving and calls each `onDismiss` once, reporting a throw from it. Never throws. */
    dismissAll,
    /** Expands or collapses the stack. Every countdown pauses while it is expanded. Never throws. */
    setExpanded,
    /** Drops every toast without calling its `onDismiss`, for when overlays cannot render. Never throws. */
    clear,
    /**
     * Drops every toast without calling its `onDismiss` and stops the countdowns and the page listener. Never
     * throws. Safe to repeat. The stack works as a fresh one afterwards.
     */
    dispose,
  };

  function show(): () => void {
    views++;
    if (views === 1) {
      resumeAll();
    }
    const generation = viewGeneration;
    let shown = true;
    return release;

    function release(): void {
      if (!shown || generation !== viewGeneration) {
        return;
      }
      shown = false;
      views--;
      if (views === 0) {
        pauseAll();
      }
    }
  }

  function push(input: ToastInput): number {
    bindPageOnce();
    const id = nextId++;
    countdowns.set(id, {
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
    const current = state.get();
    state.set({ ...current, items: [...current.items, entry] });
    start(id);
    return id;
  }

  function dismiss(id: number): void {
    const current = state.get();
    const entry = current.items.find(toast => toast.id === id);
    if (entry === undefined || entry.leaving) {
      return;
    }
    finishCountdown(id);
    state.set({
      ...current,
      items: current.items.map(toast => (toast.id === id ? { ...toast, leaving: true } : toast)),
    });
  }

  function remove(id: number): void {
    const current = state.get();
    if (!current.items.some(toast => toast.id === id)) {
      return;
    }
    countdowns.delete(id);
    const items = current.items.filter(toast => toast.id !== id);
    const collapse = current.expanded && items.length <= 1;
    state.set({ items, expanded: collapse ? false : current.expanded });
    if (collapse) {
      resumeAll();
    }
  }

  function dismissAll(): void {
    const current = state.get();
    const active = current.items.filter(toast => !toast.leaving);
    if (active.length === 0) {
      return;
    }
    pauseAll();
    for (const toast of active) {
      finishCountdown(toast.id);
    }
    state.set({
      ...current,
      items: current.items.map(toast => (toast.leaving ? toast : { ...toast, leaving: true })),
    });
  }

  function setExpanded(expanded: boolean): void {
    const current = state.get();
    if (current.expanded === expanded) {
      return;
    }
    state.set({ ...current, expanded });
    if (expanded) {
      pauseAll();
    } else {
      resumeAll();
    }
  }

  function clear(): void {
    pauseAll();
    countdowns.clear();
    state.set(INITIAL);
  }

  function dispose(): void {
    clear();
    unbindPage();
  }

  /** The page the countdowns pause with, bound on first use so building the stack never reads the document. */
  function bindPageOnce(): ToastPage {
    if (bound !== undefined) {
      return bound;
    }
    const target = page ?? document;
    const binding = new AbortController();
    pageBinding = binding;
    bound = target;
    target.addEventListener(
      'visibilitychange',
      () => {
        if (target.visibilityState === 'visible') {
          resumeAll();
        } else {
          pauseAll();
        }
      },
      { signal: binding.signal },
    );
    return target;
  }

  function unbindPage(): void {
    pageBinding?.abort();
    pageBinding = undefined;
    bound = undefined;
  }

  function shouldPause(): boolean {
    return views === 0 || state.get().expanded || bindPageOnce().visibilityState !== 'visible';
  }

  function start(id: number): void {
    const countdown = countdowns.get(id);
    if (countdown === undefined || countdown.remaining <= 0 || countdown.handle !== undefined || shouldPause()) {
      return;
    }
    countdown.startedAt = timers.now();
    countdown.handle = timers.setTimeout(() => {
      countdown.handle = undefined;
      dismiss(id);
    }, countdown.remaining);
  }

  function pause(id: number): void {
    const countdown = countdowns.get(id);
    if (countdown?.handle === undefined) {
      return;
    }
    timers.clearTimeout(countdown.handle);
    countdown.handle = undefined;
    countdown.remaining = Math.max(0, countdown.remaining - (timers.now() - countdown.startedAt));
  }

  function pauseAll(): void {
    for (const id of countdowns.keys()) {
      pause(id);
    }
  }

  function resumeAll(): void {
    if (shouldPause()) {
      return;
    }
    for (const id of countdowns.keys()) {
      start(id);
    }
  }

  function finishCountdown(id: number): void {
    const countdown = countdowns.get(id);
    pause(id);
    countdowns.delete(id);
    try {
      countdown?.onDismiss?.();
    } catch (error) {
      reportDismissError(error);
    }
  }

  function resetState(): void {
    clear();
    nextId = 0;
    views = 0;
    viewGeneration++;
    unbindPage();
  }
}

/** The page's toast stack, over the document and the page's own timers. */
export const toasts = createToasts();
