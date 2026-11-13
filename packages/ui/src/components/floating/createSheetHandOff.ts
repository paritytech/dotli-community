// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A sheet that a closing sheet's chosen item opens, or a press over it, takes the closing sheet's place in the same
// frame. `flush()` never runs inside a transition: a caller of `take` or `hold` may run during a flush and needs its
// answer at once, and an event sent inside a transition waits until that transition ends.

import { createReporter, defineCount } from '@dotli/metrics';
import {
  createStateMachine,
  realTimers,
  type HandlerOf,
  type MachineTypes,
  type Timers,
  type Transition,
} from '@dotli/shared';
import { flush as flushSolid } from 'solid-js';

const report = createReporter({ flow: 'ui' });
const sheetHandOffTransitionMetric = defineCount<'error'>('sheet_handoff.transition');

type Params = {
  /** Runs the page's pending writes, so a reader of the hand-off sees the writes. Solid's own unless given. */
  flush?: typeof flushSolid;
  /** Where a press's click arrives. The window unless given, read at each press. */
  target?: EventTarget;
  /** The zero timer a press whose click never comes ends on. The page's own unless given. */
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
};

type PressParams = {
  /** Closes the top sheet. */
  dismiss: () => void;
  /** Whether the pressed-over sheet is still the top layer once dismissed. */
  isTop: () => boolean;
};

type Settle = (taken: boolean) => void;

/** `leaving` are the closing sheets held up until the hand-off ends. `waiting` stops a press's wait on its click. */
type HandOffState =
  | { kind: 'idle' }
  /** A press closed the top sheet, and its click or the next task ends the hand-off. */
  | { kind: 'pressed'; leaving: readonly Settle[]; waiting: AbortController }
  /** A sheet opened in the leaving sheets' place while the press waits on its click or the next task. */
  | { kind: 'pressTaken'; leaving: readonly Settle[]; waiting: AbortController }
  /** An activation runs, and no sheet has opened in the leaving sheets' place yet. */
  | { kind: 'pending'; leaving: readonly Settle[] }
  /** A sheet opened in their place. */
  | { kind: 'taken'; leaving: readonly Settle[] };

type HandOffEvent =
  | { kind: 'begun' }
  | { kind: 'pressed' }
  | { kind: 'stayedOnTop' }
  | { kind: 'opened' }
  | { kind: 'held'; settle: Settle }
  | { kind: 'finished' }
  | { kind: 'failed' };

/** One `settle` per closing sheet, so a sheet that throws on hearing it leaves the rest told. */
type HandOffEffect = { kind: 'settle'; settle: Settle; taken: boolean };

type HandOffMachine = MachineTypes<HandOffState, HandOffEvent, HandOffEffect>;

/** A page's sheet hand-off, as its factory builds it. */
export type SheetHandOff = ReturnType<typeof createSheetHandOff>;

/** A sheet hand-off: a closing sheet stays up until it hears whether a sheet opened in its place. */
export function createSheetHandOff({ flush = flushSolid, target, timers = realTimers }: Params = {}) {
  /** Holds a closing sheet up until the hand-off ends. */
  const addLeaving: HandlerOf<HandOffMachine, 'pressed' | 'pressTaken' | 'pending' | 'taken', 'held'> = (
    state,
    { settle },
    { emitState },
  ) => {
    emitState({ ...state, leaving: [...state.leaving, settle] });
  };
  /** Ends a press's wait and lets the activation it waited on run. A press a sheet already took goes on as taken. */
  const endWait: HandlerOf<HandOffMachine, 'pressed' | 'pressTaken', 'begun'> = (
    { kind, leaving, waiting },
    _event,
    { emitState },
  ) => {
    emitState({ kind: kind === 'pressTaken' ? 'taken' : 'pending', leaving });
    waiting.abort();
  };
  /** Ends a press whose sheet stays on top with none leaving at once. A sheet still leaving keeps it waiting. */
  const cutPress: HandlerOf<HandOffMachine, 'pressed' | 'pressTaken', 'stayedOnTop'> = (
    { leaving, waiting },
    _event,
    { emitState },
  ) => {
    if (leaving.length > 0) {
      return;
    }
    emitState({ kind: 'idle' });
    waiting.abort();
  };
  /** Ends the hand-off and tells each closing sheet whether a sheet took its place. A failed activation leaves it untaken. */
  function endHandOff(
    { kind, leaving }: Extract<HandOffState, { kind: 'pending' | 'taken' }>,
    event: Extract<HandOffEvent, { kind: 'finished' | 'failed' }>,
    { emitState, emitSideEffect }: Transition<HandOffMachine>,
  ): void {
    emitState({ kind: 'idle' });
    const taken = kind === 'taken' && event.kind === 'finished';
    for (const settle of leaving) {
      emitSideEffect({ kind: 'settle', settle, taken });
    }
  }
  const machine = createStateMachine<HandOffMachine>({
    initial: { kind: 'idle' },
    handlers: {
      idle: {
        begun(_state, _event, { emitState }) {
          emitState({ kind: 'pending', leaving: [] });
        },
        pressed(_state, _event, { emitState, update }) {
          // A DOM event and a timer fire from the event loop, outside any transition, so each may flush.
          const endPress = (): void => {
            update({ kind: 'begun' });
            try {
              flush();
            } catch (error) {
              update({ kind: 'failed' });
              flush();
              throw error;
            }
            update({ kind: 'finished' });
            flush();
          };
          const waiting = new AbortController();
          (target ?? window).addEventListener('click', endPress, { signal: waiting.signal });
          const timer = timers.setTimeout(endPress, 0);
          waiting.signal.addEventListener('abort', () => {
            timers.clearTimeout(timer);
          });
          emitState({ kind: 'pressed', leaving: [], waiting });
        },
      },
      pressed: {
        begun: endWait,
        stayedOnTop: cutPress,
        // A bar control's click handler can open its sheet in a flush before the click reaches the target.
        opened(state, _event, { emitState }) {
          emitState({ ...state, kind: 'pressTaken' });
        },
        held: addLeaving,
      },
      pressTaken: {
        begun: endWait,
        stayedOnTop: cutPress,
        held: addLeaving,
      },
      pending: {
        opened({ leaving }, _event, { emitState }) {
          emitState({ kind: 'taken', leaving });
        },
        held: addLeaving,
        finished: endHandOff,
        failed: endHandOff,
      },
      taken: {
        held: addLeaving,
        finished: endHandOff,
        failed: endHandOff,
      },
    },
    onEffect: ({ settle, taken }) => {
      settle(taken);
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: sheetHandOffTransitionMetric,
        message: '[dot.li ui] A sheet hand-off transition threw',
      });
    },
  });

  return {
    /**
     * Runs `activate` so a sheet it opens replaces the closing one in the same frame, and returns whether one did.
     * When `activate` or its flush throws, every held sheet closes as without a hand-off and the throw is rethrown.
     */
    run,
    /**
     * For a press on a bar control outside the top sheet: `dismiss` closes that sheet now, and the press's click is the
     * hand-off's activation. The hand-off waits only while a sheet leaves. When `isTop` answers true once dismissed
     * and no sheet is leaving, it ends at once, so a sheet the press opens slides in. Otherwise it ends when the click
     * reaches the target, or next task if a listener stopped it, and a throw in that end's flush closes every held sheet
     * as without a hand-off. Throws only what `dismiss` or its flush throws.
     */
    press,
    /**
     * Claims the hand-off for a sheet that opens, and returns whether an activation was waiting on one. Read once, as a
     * sheet opens. Called from inside one of this hand-off's transitions, it is queued and answers false.
     */
    take,
    /**
     * Inside a hand-off, a closing sheet stays up until `settle` says whether another took its place. Returns whether it
     * held the sheet. Called from inside one of this hand-off's transitions, it is queued and answers false.
     */
    hold,
  };

  function run(activate: () => void): boolean {
    machine.update({ kind: 'begun' });
    try {
      activate();
      // Solid 2 batches writes until a microtask, and an opening sheet must read the hand-off while pending.
      flush();
    } catch (error) {
      machine.update({ kind: 'failed' });
      flush();
      throw error;
    }
    const taken = machine.state.get().kind === 'taken';
    // Settled in this task, so both sheets change in the same frame.
    machine.update({ kind: 'finished' });
    flush();
    return taken;
  }

  function press({ dismiss, isTop }: PressParams): void {
    machine.update({ kind: 'pressed' });
    dismiss();
    // Solid 2 batches the close until a microtask, and a hand-off waits only while the pressed-over sheet leaves, so a
    // sheet the press opens over a sheet that stays slides in.
    flush();
    if (isTop()) {
      machine.update({ kind: 'stayedOnTop' });
    }
  }

  function take(): boolean {
    const before = machine.state.get();
    machine.update({ kind: 'opened' });
    return machine.state.get() !== before;
  }

  function hold(settle: Settle): boolean {
    const before = machine.state.get();
    machine.update({ kind: 'held', settle });
    return machine.state.get() !== before;
  }
}

/** The page's. */
export const sheetHandOff = createSheetHandOff();
