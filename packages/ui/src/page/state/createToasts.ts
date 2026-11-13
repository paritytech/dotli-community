// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A countdown runs only while a view shows the toasts. It pauses while the tab is hidden or the stack is expanded and
// resumes from what was left.

import { createReporter, defineCount } from '@dotli/metrics';
import {
  createSharedRun,
  createStateMachine,
  isShallowEqual,
  listen,
  realTimers,
  registerStoreStateReset,
  type MachineTypes,
  type Timers,
  type Transition,
  type VisibilitySource,
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

type Params = {
  /** The page whose visibility pauses the countdowns. The document without one, read on the first `push`. */
  page?: VisibilitySource | undefined;
  /** The clock and timers the countdowns run on. */
  timers?: Timers | undefined;
};

type Dismiss = ToastInput['onDismiss'];

/**
 * One toast. `counting` runs its countdown on the timer `timer` names. `waiting` holds what is left of it while the stack is paused.
 * `kept` stays until closed.
 */
type Toast =
  | {
      kind: 'counting';
      entry: ToastEntry;
      onDismiss: Dismiss;
      remaining: number;
      startedAt: number;
      timer: unknown;
    }
  | { kind: 'waiting'; entry: ToastEntry; onDismiss: Dismiss; remaining: number }
  | { kind: 'kept'; entry: ToastEntry; onDismiss: Dismiss }
  | { kind: 'leaving'; entry: ToastEntry };

/**
 * The stack binds to its page on the first push. A bound stack runs its countdowns while a view shows it collapsed on
 * a visible page.
 */
type ToastsMachineState =
  | { kind: 'unbound'; viewing: boolean }
  | {
      kind: 'bound';
      stopListening: () => void;
      visible: boolean;
      viewing: boolean;
      expanded: boolean;
      toasts: ReadonlyMap<number, Toast>;
    };

type BoundState = Extract<ToastsMachineState, { kind: 'bound' }>;

type ToastsEvent =
  | { kind: 'pushed'; id: number; input: ToastInput }
  | { kind: 'dismissMsSet'; id: number; dismissMs: number }
  /** A close, or the end of the toast's countdown. */
  | { kind: 'dismissed'; id: number }
  | { kind: 'removed'; id: number }
  | { kind: 'allDismissed' }
  | { kind: 'expandedSet'; expanded: boolean }
  | { kind: 'viewsChanged'; viewing: boolean }
  | { kind: 'visibilityChanged'; visible: boolean }
  | { kind: 'cleared' }
  | { kind: 'disposed' };

type ToastsEffect = { kind: 'dismissed'; onDismiss: () => void };

type ToastsMachine = MachineTypes<ToastsMachineState, ToastsEvent, ToastsEffect>;

/** The view of an unbound stack, for a read before the store has a value. */
export const EMPTY_TOASTS: ToastsState = { items: [], expanded: false };

/**
 * Builds a toast stack whose countdowns run on `timers` and pause with `page`. Building one reads neither the page nor
 * the clock.
 */
export function createToasts({ page, timers = realTimers }: Params = {}) {
  // Ids are handed out beside the machine, since `push` answers at once and its event waits when an `onDismiss` sends it.
  let nextId = 0;
  const machine = createStateMachine<ToastsMachine>({
    initial: { kind: 'unbound', viewing: false },
    handlers: {
      unbound: {
        pushed(state, { id, input }, transition) {
          const target = page ?? document;
          const stopListening = listen({
            target,
            type: 'visibilitychange',
            handler: () => {
              transition.update({ kind: 'visibilityChanged', visible: target.visibilityState === 'visible' });
            },
          });
          emitStack(
            {
              kind: 'bound',
              stopListening,
              visible: target.visibilityState === 'visible',
              viewing: state.viewing,
              expanded: false,
              toasts: new Map([[id, buildToast(id, input)]]),
            },
            transition,
          );
        },
        viewsChanged(state, { viewing }, { emitState }) {
          emitState({ ...state, viewing });
        },
      },
      bound: {
        pushed(state, { id, input }, transition) {
          emitStack({ ...state, toasts: new Map(state.toasts).set(id, buildToast(id, input)) }, transition);
        },
        dismissMsSet(state, { id, dismissMs }, transition) {
          const toast = state.toasts.get(id);
          if (toast === undefined || toast.kind === 'leaving') {
            return;
          }
          stopTimer(toast);
          emitStack({ ...state, toasts: new Map(state.toasts).set(id, holdToast(toast, dismissMs)) }, transition);
        },
        /** Marks the toast leaving. A toast unknown or already leaving is ignored. */
        dismissed(state, { id }, { emitState, emitSideEffect }) {
          const toast = state.toasts.get(id);
          if (toast === undefined) {
            return;
          }
          emitState({ ...state, toasts: new Map(state.toasts).set(id, endToast(toast, emitSideEffect)) });
        },
        removed(state, { id }, transition) {
          const toast = state.toasts.get(id);
          if (toast === undefined) {
            return;
          }
          stopTimer(toast);
          const toasts = new Map(state.toasts);
          toasts.delete(id);
          emitStack({ ...state, toasts, expanded: state.expanded && toasts.size > 1 }, transition);
        },
        allDismissed(state, _event, { emitState, emitSideEffect }) {
          const toasts = new Map<number, Toast>();
          for (const [id, toast] of state.toasts) {
            toasts.set(id, endToast(toast, emitSideEffect));
          }
          emitState({ ...state, toasts });
        },
        expandedSet(state, { expanded }, transition) {
          emitStack({ ...state, expanded }, transition);
        },
        viewsChanged(state, { viewing }, transition) {
          emitStack({ ...state, viewing }, transition);
        },
        visibilityChanged(state, { visible }, transition) {
          emitStack({ ...state, visible }, transition);
        },
        cleared(state, _event, { emitState }) {
          emitState({ ...state, expanded: false, toasts: new Map() });
          for (const toast of state.toasts.values()) {
            stopTimer(toast);
          }
        },
        disposed(state, _event, { emitState }) {
          emitState({ kind: 'unbound', viewing: state.viewing });
          for (const toast of state.toasts.values()) {
            stopTimer(toast);
          }
          state.stopListening();
        },
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
      machine.update({ kind: 'viewsChanged', viewing: true });
      return () => {
        machine.update({ kind: 'viewsChanged', viewing: false });
      };
    },
  });

  registerStoreStateReset(() => {
    views.end();
    nextId = 0;
    dispose();
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
    /**
     * Expands or collapses the stack. Every countdown pauses while it is expanded. A stack that has held no toast since
     * it was built or disposed ignores it.
     */
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
   * Emits the stack, with each countdown started while a view shows it collapsed on a visible page, and stopped with
   * what was left of it otherwise.
   */
  function emitStack(stack: BoundState, { emitState, update }: Transition<ToastsMachine>): void {
    const running = stack.viewing && stack.visible && !stack.expanded;
    const toasts = new Map<number, Toast>();
    for (const [id, toast] of stack.toasts) {
      toasts.set(id, running ? startCountdown(toast, update) : stopCountdown(toast));
    }
    emitState({ ...stack, toasts });
  }

  /** The toast counting down what it has left. Any other toast stays as it is. */
  function startCountdown(toast: Toast, update: Transition<ToastsMachine>['update']): Toast {
    if (toast.kind !== 'waiting') {
      return toast;
    }
    const timer = timers.setTimeout(() => {
      update({ kind: 'dismissed', id: toast.entry.id });
    }, toast.remaining);
    return { ...toast, kind: 'counting', startedAt: timers.now(), timer };
  }

  /** The toast waiting with what was left of its countdown. Any other toast stays as it is. */
  function stopCountdown(toast: Toast): Toast {
    if (toast.kind !== 'counting') {
      return toast;
    }
    timers.clearTimeout(toast.timer);
    return {
      kind: 'waiting',
      entry: toast.entry,
      onDismiss: toast.onDismiss,
      remaining: Math.max(0, toast.remaining - (timers.now() - toast.startedAt)),
    };
  }

  /** The toast leaving, its countdown stopped and its `onDismiss` queued. A toast already leaving stays as it is. */
  function endToast(toast: Toast, emitSideEffect: Transition<ToastsMachine>['emitSideEffect']): Toast {
    if (toast.kind === 'leaving') {
      return toast;
    }
    stopTimer(toast);
    if (toast.onDismiss !== undefined) {
      emitSideEffect({ kind: 'dismissed', onDismiss: toast.onDismiss });
    }
    return { kind: 'leaving', entry: { ...toast.entry, leaving: true } };
  }

  /** Stops the toast's countdown, if it runs one. */
  function stopTimer(toast: Toast): void {
    if (toast.kind === 'counting') {
      timers.clearTimeout(toast.timer);
    }
  }
}

/** The page's toast stack, over the document and the page's own timers. */
export const toasts = createToasts();

/** A live toast that waits out `dismissMs` once its stack runs, or is kept until closed for 0. */
function holdToast({ entry, onDismiss }: { entry: ToastEntry; onDismiss: Dismiss }, dismissMs: number): Toast {
  if (dismissMs === 0) {
    return { kind: 'kept', entry, onDismiss };
  }
  return { kind: 'waiting', entry, onDismiss, remaining: dismissMs };
}

/** A toast, new on the stack, from what a caller pushed. */
function buildToast(id: number, input: ToastInput): Toast {
  const { dismissMs, onDismiss, tone = 'info', ...shown } = input;
  return holdToast({ entry: { ...shown, id, tone, leaving: false }, onDismiss }, dismissMs);
}

function toView(state: ToastsMachineState): ToastsState {
  switch (state.kind) {
    case 'unbound':
      return EMPTY_TOASTS;
    case 'bound':
      return { items: Array.from(state.toasts.values(), toast => toast.entry), expanded: state.expanded };
  }
}

/** The previous value is missing on a computed store's first run. */
function isSameView(previous: ToastsState | undefined, next: ToastsState): boolean {
  return previous?.expanded === next.expanded && isShallowEqual(previous.items, next.items);
}
