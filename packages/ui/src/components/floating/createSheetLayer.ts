// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createReporter, defineCount } from '@dotli/metrics';
import { createStateMachine, type HandlerOf, type MachineTypes } from '@dotli/shared';
import { sheetHandOff, type SheetHandOff } from './createSheetHandOff.js';

const report = createReporter({ flow: 'ui' });
const sheetLayerTransitionMetric = defineCount<'error'>('sheet_layer.transition');

type Params = {
  /** The hand-off a sheet that opens or closes joins. The page's unless given. */
  handOff?: Pick<SheetHandOff, 'take' | 'hold'>;
};

type SheetLayerState =
  | { kind: 'closed'; handedOff: boolean }
  | { kind: 'open'; handedOff: boolean }
  /** Closed inside a hand-off, up until it is known whether another sheet took its place. */
  | { kind: 'held'; handedOff: boolean };

type HeldState = Extract<SheetLayerState, { kind: 'held' }>;

type CallerEvent = { kind: 'opened' } | { kind: 'closed' };

type SheetLayerEvent = CallerEvent | { kind: 'settled'; held: HeldState; taken: boolean };

type SheetLayerMachine = MachineTypes<SheetLayerState, SheetLayerEvent>;

/** A bottom sheet's layer: whether it is up, and whether it came or went in a hand-off with another sheet. */
export function createSheetLayer({ handOff = sheetHandOff }: Params = {}) {
  const open: HandlerOf<SheetLayerMachine, 'closed' | 'held', 'opened'> = (_state, _event, { emitState }) => {
    emitState({ kind: 'open', handedOff: handOff.take() });
  };
  const machine = createStateMachine<SheetLayerMachine>({
    initial: { kind: 'closed', handedOff: false },
    handlers: {
      closed: { opened: open },
      open: {
        closed({ handedOff }, _event, { emitState, update }) {
          const held: HeldState = { kind: 'held', handedOff };
          if (handOff.hold(taken => update({ kind: 'settled', held, taken }))) {
            emitState(held);
            return;
          }
          emitState({ kind: 'closed', handedOff: false });
        },
      },
      held: {
        opened: open,
        settled(state, { held, taken }, { emitState }) {
          // A settle from an earlier hold, once the sheet reopened and closed again, is not this hold's.
          if (state !== held) {
            return;
          }
          emitState({ kind: 'closed', handedOff: taken });
        },
      },
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: sheetLayerTransitionMetric,
        message: '[dot.li ui] A sheet layer transition threw',
      });
    },
  });

  return {
    /** The layer as it is now. */
    state: machine.state,
    /** Takes the sheet's `opened` or `closed`, and moves the layer before it returns. */
    update(event: CallerEvent): void {
      machine.update(event);
    },
  };
}

/** Whether the sheet is up, which it stays while held. */
export function isLayerOpen(layer: SheetLayerState): boolean {
  switch (layer.kind) {
    case 'open':
    case 'held':
      return true;
    case 'closed':
      return false;
  }
}
