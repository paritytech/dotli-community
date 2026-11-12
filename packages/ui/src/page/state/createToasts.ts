// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A countdown runs only while a view shows the toasts. It pauses while the tab is hidden or the stack is expanded and
// resumes from what was left.

import { createReporter, defineCount } from '@dotli/metrics';
import {
  createSharedRun,
  createStateMachine,
  isShallowEqual,
  nest,
  realTimers,
  registerStoreStateReset,
  type HandlerOf,
  type MachineTypes,
  type Timers,
  type Transition,
} from '@dotli/shared';
import { computed, type ReadableAtom } from 'nanostores';
import type { StatusTone } from '../statusTone.js';
import type { Component } from 'solid-js';
import type { IconProps } from '../../components/icons/iconProps.js';

const report = createReporter({ flow: 'ui' });
const toastsTransitionMetric = defineCount<'error'>('toasts.transition');

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
  /** The page whose visibility pauses the countdowns. The document without one, read on the first `push`. */
  page?: ToastPage | undefined;
  /** The clock and timers the countdowns run on. */
  timers?: Timers | undefined;
};

type Dismiss = ToastInput['onDismiss'];

/** One toast. `waiting` holds what is left of its countdown while the stack is paused. `kept` stays until closed. */
type Toast =
  | { kind: 'counting'; entry: ToastEntry; onDismiss: Dismiss; remaining: number; startedAt: number; timer: unknown }
  | { kind: 'waiting'; entry: ToastEntry; onDismiss: Dismiss; remaining: number }
  | { kind: 'kept'; entry: ToastEntry; onDismiss: Dismiss }
  | { kind: 'leaving'; entry: ToastEntry };

type LiveToast = Exclude<Toast, { kind: 'leaving' }>;

type BoundPage = { page: ToastPage; stopListening: () => void };

/** A bound stack runs its countdowns while a view shows it collapsed on a visible page, and is paused otherwise. */
type ToastsMachineState =
  | { kind: 'unbound'; expanded: boolean }
  | { kind: 'paused'; bound: BoundPage; expanded: boolean; toasts: ReadonlyMap<number, Toast> }
  | { kind: 'running'; bound: BoundPage; expanded: boolean; toasts: ReadonlyMap<number, Toast> };

type BoundState = Extract<ToastsMachineState, { kind: 'paused' | 'running' }>;

type ToastsEvent =
  | { kind: 'pushed'; id: number; input: ToastInput }
  | { kind: 'dismissMsSet'; id: number; dismissMs: number }
  | { kind: 'dismissed'; id: number }
  | { kind: 'countdownEnded'; id: number }
  | { kind: 'removed'; id: number }
  | { kind: 'allDismissed' }
  | { kind: 'expandedSet'; expanded: boolean }
  | { kind: 'viewsChanged' }
  | { kind: 'visibilityChanged' }
  | { kind: 'cleared' }
  | { kind: 'disposed' };

type ToastsEffect = { kind: 'dismissed'; onDismiss: () => void };

type ToastsMachine = MachineTypes<ToastsMachineState, ToastsEvent, ToastsEffect>;

type ToastMachine = MachineTypes<Toast, ToastsEvent, ToastsEffect>;

/** The view of an unbound stack that is not expanded, for a read before the store has a value. */
export const EMPTY_TOASTS: ToastsState = { items: [], expanded: false };

/**
 * Builds a toast stack whose countdowns run on `timers` and pause with `page`. Building one reads neither the page nor
 * the clock.
 */
export function createToasts({ page, timers = realTimers }: Params = {}) {
  let viewing = false;
  let nextId = 0;
  const addToast: HandlerOf<ToastsMachine, 'paused' | 'running', 'pushed'> = (state, { id, input }, transition) => {
    emitBound({ ...state, toasts: new Map(state.toasts).set(id, buildToast(id, input)) }, transition);
  };
  const removeToast: HandlerOf<ToastsMachine, 'paused' | 'running', 'removed'> = (state, { id }, transition) => {
    const toast = state.toasts.get(id);
    if (toast === undefined) {
      return;
    }
    clearTimer(toast);
    const toasts = new Map(state.toasts);
    toasts.delete(id);
    emitBound({ ...state, toasts, expanded: state.expanded && toasts.size > 1 }, transition);
  };
  const dismissEvery: HandlerOf<ToastsMachine, 'paused' | 'running', 'allDismissed'> = (state, _event, transition) => {
    const toasts = new Map<number, Toast>();
    for (const [id, toast] of state.toasts) {
      toasts.set(id, endToast(toast, transition.emitSideEffect));
    }
    emitBound({ ...state, toasts }, transition);
  };
  const expandOrCollapse: HandlerOf<ToastsMachine, 'paused' | 'running', 'expandedSet'> = (
    state,
    { expanded },
    transition,
  ) => {
    emitBound({ ...state, expanded }, transition, state);
  };
  const clearToasts: HandlerOf<ToastsMachine, 'paused' | 'running', 'cleared'> = (state, _event, transition) => {
    for (const toast of state.toasts.values()) {
      clearTimer(toast);
    }
    emitBound({ bound: state.bound, expanded: false, toasts: new Map() }, transition);
  };
  const unbindPage: HandlerOf<ToastsMachine, 'paused' | 'running', 'disposed'> = (state, _event, { emitState }) => {
    emitState({ kind: 'unbound', expanded: false });
    for (const toast of state.toasts.values()) {
      clearTimer(toast);
    }
    state.bound.stopListening();
  };
  const restartCountdown: HandlerOf<ToastMachine, LiveToast['kind'], 'dismissMsSet'> = (
    toast,
    { id, dismissMs },
    { emitState, update },
  ) => {
    clearTimer(toast);
    emitState(startCountdown(id, holdToast(toast, dismissMs), update));
  };
  const holdCountdown: HandlerOf<ToastMachine, LiveToast['kind'], 'dismissMsSet'> = (
    toast,
    { dismissMs },
    { emitState },
  ) => {
    clearTimer(toast);
    emitState(holdToast(toast, dismissMs));
  };
  const routeRunning = nest<ToastsMachine, 'running', ToastMachine, 'dismissed' | 'countdownEnded' | 'dismissMsSet'>({
    find: findToast,
    store: storeToast,
    handlers: {
      counting: { dismissed: leaveToast, countdownEnded: leaveToast, dismissMsSet: restartCountdown },
      waiting: { dismissed: leaveToast, dismissMsSet: restartCountdown },
      kept: { dismissed: leaveToast, dismissMsSet: restartCountdown },
      leaving: null,
    },
  });
  const routePaused = nest<ToastsMachine, 'paused', ToastMachine, 'dismissed' | 'countdownEnded' | 'dismissMsSet'>({
    find: findToast,
    store: storeToast,
    handlers: {
      counting: { dismissed: leaveToast, countdownEnded: leaveToast, dismissMsSet: holdCountdown },
      waiting: { dismissed: leaveToast, dismissMsSet: holdCountdown },
      kept: { dismissed: leaveToast, dismissMsSet: holdCountdown },
      leaving: null,
    },
  });
  const machine = createStateMachine<ToastsMachine>({
    initial: { kind: 'unbound', expanded: false },
    handlers: {
      unbound: {
        pushed(state, { id, input }, transition) {
          const target = page ?? document;
          const binding = new AbortController();
          target.addEventListener(
            'visibilitychange',
            () => {
              transition.update({ kind: 'visibilityChanged' });
            },
            { signal: binding.signal },
          );
          const bound = {
            page: target,
            stopListening: () => {
              binding.abort();
            },
          };
          emitBound(
            { bound, expanded: state.expanded, toasts: new Map<number, Toast>().set(id, buildToast(id, input)) },
            transition,
          );
        },
        expandedSet(_state, { expanded }, { emitState }) {
          emitState({ kind: 'unbound', expanded });
        },
        cleared: collapseUnbound,
        disposed: collapseUnbound,
      },
      paused: {
        pushed: addToast,
        dismissMsSet: routePaused,
        dismissed: routePaused,
        countdownEnded: routePaused,
        removed: removeToast,
        allDismissed: dismissEvery,
        expandedSet: expandOrCollapse,
        viewsChanged: settleCountdowns,
        visibilityChanged: settleCountdowns,
        cleared: clearToasts,
        disposed: unbindPage,
      },
      running: {
        pushed: addToast,
        dismissMsSet: routeRunning,
        dismissed: routeRunning,
        countdownEnded: routeRunning,
        removed: removeToast,
        allDismissed: dismissEvery,
        expandedSet: expandOrCollapse,
        viewsChanged: settleCountdowns,
        visibilityChanged: settleCountdowns,
        cleared: clearToasts,
        disposed: unbindPage,
      },
    },
    onEffect: ({ onDismiss }) => {
      try {
        onDismiss();
      } catch (error) {
        report.listener('toast.dismiss')(error);
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: toastsTransitionMetric,
        message: '[dot.li ui] A toast transition threw',
      });
    },
  });
  const store: ReadableAtom<ToastsState> = computed(machine.state, toView);
  store.eq = isSameView;
  const views = createSharedRun({
    begin: () => {
      viewing = true;
      machine.update({ kind: 'viewsChanged' });
      return () => {
        viewing = false;
        machine.update({ kind: 'viewsChanged' });
      };
    },
  });

  registerStoreStateReset(() => {
    views.end();
    nextId = 0;
    machine.update({ kind: 'disposed' });
  });

  return {
    /** The toasts on screen and whether the stack is expanded. */
    store,
    /**
     * A view calls it on mount and the returned function on unmount. The first view starts the countdowns, the last
     * pauses them. The returned function releases once, and nothing after a reset.
     */
    show,
    /**
     * Adds a toast as the newest and returns its id. Its countdown starts while a view shows the stack. Called from an
     * `onDismiss`, the toast is added right after that dismissal.
     */
    push,
    /**
     * Gives the toast a new countdown of `dismissMs`, which runs while a view shows the stack. 0 keeps it until closed. A
     * toast unknown or leaving is ignored.
     */
    setDismissMs,
    /**
     * Marks the toast leaving and calls its `onDismiss` once, reporting a throw from it. A toast unknown or already
     * leaving is ignored.
     */
    dismiss,
    /** Drops the toast once its exit animation has finished. An unknown id is ignored. */
    remove,
    /** Marks every toast leaving, then calls each `onDismiss` once in order, reporting a throw from it. */
    dismissAll,
    /** Expands or collapses the stack. Every countdown pauses while it is expanded. */
    setExpanded,
    /** Drops every toast without calling its `onDismiss`, for when overlays cannot render. */
    clear,
    /**
     * Drops every toast without calling its `onDismiss` and stops the countdowns and the page listener. Safe to repeat.
     * The stack works as a fresh one afterwards.
     */
    dispose,
  };

  function show(): () => void {
    return views.join();
  }

  function push(input: ToastInput): number {
    const id = nextId;
    nextId += 1;
    machine.update({ kind: 'pushed', id, input });
    return id;
  }

  function setDismissMs(id: number, dismissMs: number): void {
    machine.update({ kind: 'dismissMsSet', id, dismissMs });
  }

  function dismiss(id: number): void {
    machine.update({ kind: 'dismissed', id });
  }

  function remove(id: number): void {
    machine.update({ kind: 'removed', id });
  }

  function dismissAll(): void {
    machine.update({ kind: 'allDismissed' });
  }

  function setExpanded(expanded: boolean): void {
    machine.update({ kind: 'expandedSet', expanded });
  }

  function clear(): void {
    machine.update({ kind: 'cleared' });
  }

  function dispose(): void {
    machine.update({ kind: 'disposed' });
  }

  /**
   * Emits the bound stack as `running` while a view shows it collapsed on a visible page, else as `paused`, with each
   * countdown started or stopped to match. With `previous`, it emits nothing when the stack comes out as it was.
   */
  function emitBound(
    stack: Omit<BoundState, 'kind'>,
    { emitState, update }: Transition<ToastsMachine>,
    previous?: BoundState,
  ): void {
    const running = viewing && !stack.expanded && stack.bound.page.visibilityState === 'visible';
    const toasts = new Map<number, Toast>();
    for (const [id, toast] of stack.toasts) {
      toasts.set(id, running ? startCountdown(id, toast, update) : stopCountdown(toast));
    }
    const next: BoundState = { ...stack, kind: running ? 'running' : 'paused', toasts };
    if (previous !== undefined && isSameStack(previous, next)) {
      return;
    }
    emitState(next);
  }

  function settleCountdowns(
    state: BoundState,
    _event: Extract<ToastsEvent, { kind: 'viewsChanged' | 'visibilityChanged' }>,
    transition: Transition<ToastsMachine>,
  ): void {
    emitBound(state, transition, state);
  }

  function leaveToast(
    toast: LiveToast,
    _event: Extract<ToastsEvent, { kind: 'dismissed' | 'countdownEnded' }>,
    { emitState, emitSideEffect }: Transition<ToastMachine>,
  ): void {
    emitState(endToast(toast, emitSideEffect));
  }

  /** The toast leaving, its countdown stopped and its `onDismiss` queued. A toast already leaving stays as it is. */
  function endToast(toast: Toast, emitSideEffect: Transition<ToastsMachine>['emitSideEffect']): Toast {
    switch (toast.kind) {
      case 'leaving':
        return toast;
      case 'counting':
      case 'waiting':
      case 'kept':
        clearTimer(toast);
        if (toast.onDismiss !== undefined) {
          emitSideEffect({ kind: 'dismissed', onDismiss: toast.onDismiss });
        }
        return { kind: 'leaving', entry: { ...toast.entry, leaving: true } };
    }
  }

  /** The toast counting down what it has left, with a timer that ends it. Any other toast stays as it is. */
  function startCountdown(id: number, toast: Toast, update: Transition<ToastsMachine>['update']): Toast {
    switch (toast.kind) {
      case 'waiting': {
        const timer = timers.setTimeout(() => {
          update({ kind: 'countdownEnded', id });
        }, toast.remaining);
        return { ...toast, kind: 'counting', startedAt: timers.now(), timer };
      }
      case 'counting':
      case 'kept':
      case 'leaving':
        return toast;
    }
  }

  /** The toast waiting with what was left of its countdown. Any other toast stays as it is. */
  function stopCountdown(toast: Toast): Toast {
    switch (toast.kind) {
      case 'counting':
        timers.clearTimeout(toast.timer);
        return {
          kind: 'waiting',
          entry: toast.entry,
          onDismiss: toast.onDismiss,
          remaining: Math.max(0, toast.remaining - (timers.now() - toast.startedAt)),
        };
      case 'waiting':
      case 'kept':
      case 'leaving':
        return toast;
    }
  }

  function clearTimer(toast: Toast): void {
    switch (toast.kind) {
      case 'counting':
        timers.clearTimeout(toast.timer);
        return;
      case 'waiting':
      case 'kept':
      case 'leaving':
        return;
    }
  }
}

/** The page's toast stack, over the document and the page's own timers. */
export const toasts = createToasts();

/** A live toast that waits out `dismissMs` once its stack runs, or is kept until closed for 0. */
function holdToast({ entry, onDismiss }: Pick<LiveToast, 'entry' | 'onDismiss'>, dismissMs: number): Toast {
  if (dismissMs === 0) {
    return { kind: 'kept', entry, onDismiss };
  }
  return { kind: 'waiting', entry, onDismiss, remaining: dismissMs };
}

/** A toast, new on the stack, from what a caller pushed. */
function buildToast(id: number, input: ToastInput): Toast {
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
  return holdToast({ entry, onDismiss: input.onDismiss }, input.dismissMs);
}

/** Whether the stack kept its phase, its expansion and every toast as it was. */
function isSameStack(previous: BoundState, next: BoundState): boolean {
  if (previous.kind !== next.kind || previous.expanded !== next.expanded || previous.toasts.size !== next.toasts.size) {
    return false;
  }
  for (const [id, toast] of next.toasts) {
    if (previous.toasts.get(id) !== toast) {
      return false;
    }
  }
  return true;
}

function collapseUnbound(
  _state: Extract<ToastsMachineState, { kind: 'unbound' }>,
  _event: Extract<ToastsEvent, { kind: 'cleared' | 'disposed' }>,
  { emitState }: Transition<ToastsMachine>,
): void {
  emitState({ kind: 'unbound', expanded: false });
}

function findToast({ toasts }: BoundState, { id }: { id: number }): Toast | null {
  return toasts.get(id) ?? null;
}

function storeToast<State extends BoundState>(state: State, { id }: { id: number }, next: Toast): State {
  return { ...state, toasts: new Map(state.toasts).set(id, next) };
}

function toView(state: ToastsMachineState): ToastsState {
  switch (state.kind) {
    case 'unbound':
      return { ...EMPTY_TOASTS, expanded: state.expanded };
    case 'paused':
    case 'running':
      return { items: Array.from(state.toasts.values(), toast => toast.entry), expanded: state.expanded };
  }
}

/** The previous value is missing on a computed store's first run. */
function isSameView(previous: ToastsState | undefined, next: ToastsState): boolean {
  return previous?.expanded === next.expanded && isShallowEqual(previous.items, next.items);
}
