// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A device grant from the product's own prompt rebuilds the product's frame, which must not go before the prompt's
// answer has reached the product. The gate holds a run back until it is shown that answer forwarded.

import { decodeWireMessage, MESSAGE_TYPE_RESPONSE } from '@parity/truapi';
import { PERMISSIONS_REQUEST_DEVICE_PERMISSION } from '@parity/truapi/wire-table';
import { createReporter, defineCount } from '@dotli/metrics';
import { createStateMachine, realTimers, type MachineTypes, type Timers, type Transition } from '@dotli/shared';

const report = createReporter({ flow: 'wallet' });
/** A transition of the gate that threw. */
const responseGateTransitionMetric = defineCount<'error'>('permissions.response_gate_transition');

type Params = {
  /** The frame's lifetime. Once it aborts, nothing held back runs. */
  signal: AbortSignal;
  /** How long a run waits for an answer that may never come, as a lost one would keep the old policy in force. */
  timeoutMs: number;
  /** The timers the wait runs on. The page's own by default. */
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
};

type GateState =
  { kind: 'idle' } | { kind: 'holding'; runs: readonly (() => void)[]; timer: unknown } | { kind: 'ended' };

type GateEvent =
  | { kind: 'asked'; run: () => void }
  | { kind: 'forwarded'; message: Uint8Array }
  | { kind: 'timedOut' }
  | { kind: 'ended' };

type GateEffect = { kind: 'released'; run: () => void } | { kind: 'waitStopped'; timer: unknown };

type GateMachine = MachineTypes<GateState, GateEvent, GateEffect>;

/** Builds a gate for one frame's lifetime. Building it never throws. */
export function createPermissionResponseGate({ signal, timeoutMs, timers = realTimers }: Params) {
  const gate = createStateMachine<GateMachine>({
    initial: signal.aborted ? { kind: 'ended' } : { kind: 'idle' },
    handlers: {
      idle: {
        asked(_state, { run }, { emitState, update }) {
          const timer = timers.setTimeout(() => {
            update({ kind: 'timedOut' });
          }, timeoutMs);
          emitState({ kind: 'holding', runs: [run], timer });
        },
        ended(_state, _event, { emitState }) {
          emitState({ kind: 'ended' });
        },
      },
      holding: {
        asked(state, { run }, { emitState }) {
          emitState({ ...state, runs: [...state.runs, run] });
        },
        // Only a holding gate decodes, so a frame forwarded while nothing waits costs no decode.
        forwarded(state, { message }, transition) {
          if (!isDevicePermissionAnswer(message)) {
            return;
          }
          releaseRuns(state, transition);
        },
        timedOut(state, _event, transition) {
          releaseRuns(state, transition);
        },
        ended(state, _event, { emitState, emitSideEffect }) {
          emitState({ kind: 'ended' });
          emitSideEffect({ kind: 'waitStopped', timer: state.timer });
        },
      },
      ended: null,
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'released':
          effect.run();
          return;
        case 'waitStopped':
          timers.clearTimeout(effect.timer);
          return;
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'response_gate_transition',
        metric: responseGateTransitionMetric,
        message: '[dot.li] A permission response gate transition threw',
      });
    },
  });

  // An aborted signal fires no more, so its listener never runs.
  signal.addEventListener(
    'abort',
    () => {
      gate.update({ kind: 'ended' });
    },
    { once: true },
  );

  return {
    /**
     * Runs `run` once the next device permission answer has been forwarded to the product, or the wait is over, and
     * never once the frame's lifetime ended. A run that throws is reported, and the runs after it still run.
     */
    runAfterResponse,
    /**
     * Is shown each core frame once it was forwarded to the product. A device permission answer releases every held
     * run. A run that throws is reported, and the runs after it still run.
     */
    noteForwarded,
  };

  function runAfterResponse(run: () => void): void {
    gate.update({ kind: 'asked', run });
  }

  function noteForwarded(message: Uint8Array): void {
    gate.update({ kind: 'forwarded', message });
  }

  /** Moves a wait to `idle`, stops its timer and releases its runs in order. */
  function releaseRuns(
    state: Extract<GateState, { kind: 'holding' }>,
    { emitState, emitSideEffect }: Transition<GateMachine>,
  ): void {
    emitState({ kind: 'idle' });
    emitSideEffect({ kind: 'waitStopped', timer: state.timer });
    for (const run of state.runs) {
      emitSideEffect({ kind: 'released', run });
    }
  }
}

function isDevicePermissionAnswer(message: Uint8Array): boolean {
  const decoded = decodeWireMessage(message);
  if (decoded.isErr()) {
    return false;
  }
  const { payload } = decoded.value;
  return (
    payload.messageType === MESSAGE_TYPE_RESPONSE &&
    payload.traitId === PERMISSIONS_REQUEST_DEVICE_PERMISSION.trait &&
    payload.methodId === PERMISSIONS_REQUEST_DEVICE_PERMISSION.method
  );
}
