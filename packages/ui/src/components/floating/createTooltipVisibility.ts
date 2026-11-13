// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createReporter, defineCount } from '@dotli/metrics';
import { createStateMachine, realTimers, type MachineTypes, type Timers, type Transition } from '@dotli/shared';

const report = createReporter({ flow: 'ui' });
const tooltipTransitionMetric = defineCount<'error'>('tooltip.transition');

/** How long a mouse rests on the trigger before the tooltip shows. */
export const TOOLTIP_SHOW_MS = 200;
/** Grace after the mouse leaves both the trigger and the tooltip. */
export const TOOLTIP_HIDE_MS = 100;

type Params = {
  /** Told each time the tooltip opens or closes. A throw is reported and the tooltip still moves. */
  onChange: (open: boolean) => void;
  /** The page's own by default. The show delay and the hide grace run on them. */
  timers?: Timers | undefined;
};

/** `timer` is the handle of the pending show's delay or the pending hide's grace. */
type TooltipState =
  | { kind: 'hidden' }
  | { kind: 'showing'; timer: unknown }
  | { kind: 'shown' }
  | { kind: 'hiding'; timer: unknown }
  | { kind: 'disposed' };

type TooltipEvent =
  | { kind: 'rested' }
  | { kind: 'showAsked' }
  | { kind: 'hideAsked' }
  | { kind: 'left' }
  | { kind: 'held' }
  | { kind: 'showCancelled' }
  | { kind: 'delayEnded' }
  | { kind: 'graceEnded' }
  | { kind: 'disposed' };

type TooltipEffect = { kind: 'changed'; open: boolean };

type TooltipMachine = MachineTypes<TooltipState, TooltipEvent, TooltipEffect>;

/**
 * A tooltip's phase as one value: hidden, a pending show, shown, a pending hide, or disposed. Called inside a component,
 * which disposes it on cleanup so no timer outlives it.
 */
export function createTooltipVisibility({ onChange, timers = realTimers }: Params) {
  const machine = createStateMachine<TooltipMachine>({
    initial: { kind: 'hidden' },
    handlers: {
      hidden: {
        rested: armShow,
        showAsked: showNow,
        disposed: dispose,
      },
      showing: {
        showAsked: showNow,
        delayEnded: showNow,
        hideAsked: hideNow,
        left: hideNow,
        showCancelled: hideNow,
        disposed: dispose,
      },
      shown: {
        hideAsked: hideNow,
        left: armHide,
        disposed: dispose,
      },
      hiding: {
        rested: showNow,
        held: showNow,
        showAsked: showNow,
        hideAsked: hideNow,
        graceEnded: hideNow,
        left: armHide,
        disposed: dispose,
      },
      disposed: null,
    },
    onEffect: ({ open }) => {
      onChange(open);
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: tooltipTransitionMetric,
        message: '[dot.li ui] A tooltip transition threw',
      });
    },
  });

  return {
    /** The mouse rests on the trigger: arms the show delay while hidden, and cancels a pending hide. */
    rest: () => {
      machine.update({ kind: 'rested' });
    },
    /** Shows at once, ending a pending show or hide. Does nothing once disposed. A throwing `onChange` is reported. */
    show: () => {
      machine.update({ kind: 'showAsked' });
    },
    /** Hides at once, ending a pending show or hide. Does nothing once disposed. A throwing `onChange` is reported. */
    hide: () => {
      machine.update({ kind: 'hideAsked' });
    },
    /**
     * The mouse leaves the trigger or the tooltip: cancels a pending show, and hides a shown tooltip after the grace,
     * restarting a grace already running.
     */
    leave: () => {
      machine.update({ kind: 'left' });
    },
    /** The mouse moves onto the tooltip: cancels a pending hide and changes nothing else. */
    hold: () => {
      machine.update({ kind: 'held' });
    },
    /** A press on the trigger, or the trigger going away: cancels a pending show and changes nothing else. */
    cancelShow: () => {
      machine.update({ kind: 'showCancelled' });
    },
    /** Clears the pending timer and ends the unit, so every later input does nothing. Tells `onChange` nothing. */
    dispose: () => {
      machine.update({ kind: 'disposed' });
    },
    /** Whether the tooltip is open now, through a pending hide too. */
    isOpen: () => isOpenIn(machine.state.get()),
  };

  /** Opens at once, ending a pending show or hide. Tells `onChange` only when the tooltip was closed. */
  function showNow(
    state: Extract<TooltipState, { kind: 'hidden' | 'showing' | 'hiding' }>,
    _event: TooltipEvent,
    { emitState, emitSideEffect }: Transition<TooltipMachine>,
  ): void {
    emitState({ kind: 'shown' });
    stopTimer(state);
    if (!isOpenIn(state)) {
      emitSideEffect({ kind: 'changed', open: true });
    }
  }

  /** Closes at once, ending a pending show or hide. Tells `onChange` only when the tooltip was open. */
  function hideNow(
    state: Extract<TooltipState, { kind: 'showing' | 'shown' | 'hiding' }>,
    _event: TooltipEvent,
    { emitState, emitSideEffect }: Transition<TooltipMachine>,
  ): void {
    emitState({ kind: 'hidden' });
    stopTimer(state);
    if (isOpenIn(state)) {
      emitSideEffect({ kind: 'changed', open: false });
    }
  }

  /** Starts the show delay. */
  function armShow(
    _state: TooltipState,
    _event: TooltipEvent,
    { emitState, update }: Transition<TooltipMachine>,
  ): void {
    const timer = timers.setTimeout(() => {
      update({ kind: 'delayEnded' });
    }, TOOLTIP_SHOW_MS);
    emitState({ kind: 'showing', timer });
  }

  /** Starts the hide grace, restarting one already running. */
  function armHide(
    state: Extract<TooltipState, { kind: 'shown' | 'hiding' }>,
    _event: TooltipEvent,
    { emitState, update }: Transition<TooltipMachine>,
  ): void {
    const timer = timers.setTimeout(() => {
      update({ kind: 'graceEnded' });
    }, TOOLTIP_HIDE_MS);
    emitState({ kind: 'hiding', timer });
    stopTimer(state);
  }

  /** Ends the unit and its timer, telling `onChange` nothing since its listener is going away. */
  function dispose(
    state: Exclude<TooltipState, { kind: 'disposed' }>,
    _event: TooltipEvent,
    { emitState }: Transition<TooltipMachine>,
  ): void {
    emitState({ kind: 'disposed' });
    stopTimer(state);
  }

  /** Stops the pending show's delay or the pending hide's grace that `state` holds, if any. */
  function stopTimer(state: TooltipState): void {
    if (state.kind === 'showing' || state.kind === 'hiding') {
      timers.clearTimeout(state.timer);
    }
  }
}

function isOpenIn(state: TooltipState): boolean {
  switch (state.kind) {
    case 'shown':
    case 'hiding':
      return true;
    case 'hidden':
    case 'showing':
    case 'disposed':
      return false;
  }
}
