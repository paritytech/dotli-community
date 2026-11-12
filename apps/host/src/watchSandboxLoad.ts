// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The one owner of what the sandbox said about the page's load: that it spoke, that it cleared the loading screen and
// how its load ended. The sandbox speaks within seconds of starting. A frame whose origin the browser blocks, or whose
// page never runs, says nothing, and without a deadline the load would wait for it for good.

import { isLoadedOutcome, type SandboxChannel, type SandboxLoadOutcome } from '@dotli/sandbox-wire';
import { createReporter, defineCount } from '@dotli/metrics';
import {
  createListenerSet,
  createStateMachine,
  nest,
  noop,
  realTimers,
  type HandlerOf,
  type MachineTypes,
  type Timers,
} from '@dotli/shared';

/** What the sandbox reported about how its load ended, its failed step cleaned for a tag. */
export type SandboxLoadReport = { outcome: SandboxLoadOutcome; failedStep: string | undefined };

export type SandboxLoad = ReturnType<typeof watchSandboxLoad>;

type Params = {
  /** The deadline's clock, the real one by default. */
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'> | undefined;
};

type ExpectHeardWithinParams = {
  /** Hears the sandbox's silence once the deadline passes with nothing heard. */
  onSilent: (error: SandboxSilentError) => void;
  /** How long the sandbox has to speak from the call. */
  silenceMs?: number;
};

/** The silence deadline of a sandbox not heard yet. */
type Deadline =
  { kind: 'none' } | ({ kind: 'running'; timer: unknown } & Required<ExpectHeardWithinParams>) | { kind: 'passed' };

/** Each listening state holds the channel's unsubscribe. The watch only moves forward. */
type SandboxLoadState =
  | { kind: 'idle' }
  | { kind: 'unheard'; stopListening: () => void; deadline: Deadline }
  | { kind: 'heard'; stopListening: () => void }
  | { kind: 'cleared'; stopListening: () => void }
  | { kind: 'ended'; stopListening: () => void; latest: SandboxLoadReport }
  | { kind: 'disposed' };

type SandboxLoadEvent =
  | { kind: 'started' }
  | { kind: 'statusHeard'; done: boolean; outcome: SandboxLoadOutcome | undefined; failedStep: string | undefined }
  | ({ kind: 'deadlineAsked' } & Required<ExpectHeardWithinParams>)
  | { kind: 'deadlinePassed'; timer: unknown }
  | { kind: 'deadlineStopped'; timer: unknown }
  | { kind: 'disposed' };

type SandboxLoadEffect =
  | { kind: 'cleared' }
  | { kind: 'outcome'; report: SandboxLoadReport }
  | { kind: 'silent'; onSilent: ExpectHeardWithinParams['onSilent']; error: SandboxSilentError };

type SandboxLoadMachine = MachineTypes<SandboxLoadState, SandboxLoadEvent, SandboxLoadEffect>;

/** How long the sandbox has to speak once it was handed the content. */
const SANDBOX_SILENCE_MS = 30_000;

// Becomes a Sentry tag from another origin, so anything but a short snake_case token is dropped.
const FAILED_STEP_RE = /^[a-z][a-z0-9_]{0,39}$/;

const report = createReporter({ flow: 'content' });
const sandboxLoadTransitionMetric = defineCount<'error'>('sandbox_load.transition');

/**
 * Returns the page's watch on the sandbox's load. It listens from the call until `dispose`, so a sandbox that speaks
 * before a deadline is asked still counts, and a load that ends again, such as a retry, is heard too. Never throws: a
 * throw of `channel.on` is reported, and the watch then hears nothing and asks no deadline.
 */
export function watchSandboxLoad(channel: Pick<SandboxChannel, 'on'>, { timers = realTimers }: Params = {}) {
  const clears = createListenerSet<undefined>({ onListenerError: report.listener('sandbox_load.cleared') });
  const outcomes = createListenerSet<SandboxLoadReport>({ onListenerError: report.listener('sandbox_load.outcome') });
  /** Ends the load at each `done` that comes with an outcome, and keeps it as the latest. */
  const endLoad: HandlerOf<SandboxLoadMachine, 'cleared' | 'ended', 'statusHeard'> = (
    { stopListening },
    { outcome, failedStep },
    { emitState, emitSideEffect },
  ) => {
    // A `done` without an outcome only clears the screen for a prompt the sandbox shows before its content loads.
    if (outcome === undefined) {
      return;
    }
    const latest = { outcome, failedStep: isLoadedOutcome(outcome) ? undefined : toTagStep(failedStep) };
    emitState({ kind: 'ended', stopListening, latest });
    emitSideEffect({ kind: 'outcome', report: latest });
  };
  /** Clears the screen at the sandbox's first `done`, and ends the load when that `done` carries an outcome. */
  const clearScreen: HandlerOf<SandboxLoadMachine, 'heard', 'statusHeard'> = (
    { stopListening },
    status,
    transition,
  ) => {
    if (!status.done) {
      return;
    }
    const cleared = { kind: 'cleared', stopListening } as const;
    transition.emitState(cleared);
    transition.emitSideEffect({ kind: 'cleared' });
    endLoad(cleared, status, transition);
  };
  const handleDeadline = nest<
    SandboxLoadMachine,
    'unheard',
    MachineTypes<Deadline, SandboxLoadEvent, SandboxLoadEffect>,
    'deadlinePassed' | 'deadlineStopped'
  >({
    find: state => state.deadline,
    store: (state, _event, next) => ({ ...state, deadline: next }),
    handlers: {
      none: null,
      running: {
        deadlinePassed({ timer, onSilent, silenceMs }, event, { emitState, emitSideEffect }) {
          if (event.timer !== timer) {
            return;
          }
          emitState({ kind: 'passed' });
          emitSideEffect({ kind: 'silent', onSilent, error: new SandboxSilentError(silenceMs) });
        },
        deadlineStopped({ timer }, event, { emitState }) {
          if (event.timer !== timer) {
            return;
          }
          emitState({ kind: 'none' });
          timers.clearTimeout(timer);
        },
      },
      passed: null,
    },
  });
  /** Stops listening and drops a running deadline, so nothing the sandbox says later counts. */
  const stop: HandlerOf<SandboxLoadMachine, 'unheard' | 'heard' | 'cleared' | 'ended', 'disposed'> = (
    state,
    _event,
    { emitState },
  ) => {
    emitState({ kind: 'disposed' });
    if (state.kind === 'unheard') {
      clearDeadline(state.deadline);
    }
    state.stopListening();
  };
  const load = createStateMachine<SandboxLoadMachine>({
    initial: { kind: 'idle' },
    handlers: {
      idle: {
        started(_state, _event, { emitState, update }) {
          const stopListening = channel.on('dotli:loading-status', ({ done, outcome, failedStep }) => {
            update({ kind: 'statusHeard', done: done === true, outcome, failedStep });
          });
          emitState({ kind: 'unheard', stopListening, deadline: { kind: 'none' } });
        },
        disposed(_state, _event, { emitState }) {
          emitState({ kind: 'disposed' });
        },
      },
      unheard: {
        statusHeard({ stopListening, deadline }, status, transition) {
          const heard = { kind: 'heard', stopListening } as const;
          transition.emitState(heard);
          // The same `statusHeard` carries on in the state it just moved to, so it takes the `heard` handler's step now.
          clearScreen(heard, status, transition);
          clearDeadline(deadline);
        },
        deadlineAsked(state, { onSilent, silenceMs }, { emitState, update }) {
          const timer = timers.setTimeout(() => {
            update({ kind: 'deadlinePassed', timer });
          }, silenceMs);
          emitState({ ...state, deadline: { kind: 'running', timer, onSilent, silenceMs } });
          clearDeadline(state.deadline);
        },
        deadlinePassed: handleDeadline,
        deadlineStopped: handleDeadline,
        disposed: stop,
      },
      heard: { statusHeard: clearScreen, disposed: stop },
      cleared: { statusHeard: endLoad, disposed: stop },
      ended: { statusHeard: endLoad, disposed: stop },
      disposed: null,
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'cleared':
          clears.emit(undefined);
          return;
        case 'outcome':
          outcomes.emit(effect.report);
          return;
        case 'silent':
          effect.onSilent(effect.error);
          return;
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: sandboxLoadTransitionMetric,
        message: '[dot.li] A sandbox load transition threw',
      });
    },
  });
  load.update({ kind: 'started' });

  return {
    /**
     * Until `dispose`, the listener hears the latest outcome at once when one came, then every later one in order. After
     * `dispose` it hears nothing, not even the latest. A listener that throws is reported and does not stop the others.
     * The returned unsubscribe is safe to call more than once. Never throws.
     */
    subscribeOutcomes,
    /**
     * Until `dispose`, the listener hears the sandbox's first `done`, with or without an outcome, once: at once when it
     * came already, else when it comes. After `dispose` it hears nothing. A listener that throws is reported. The
     * returned unsubscribe is safe to call more than once. Never throws.
     */
    subscribeCleared,
    /**
     * Gives the sandbox `silenceMs` from the call to speak, and calls `onSilent` with a `SandboxSilentError` when it
     * stays silent. A later ask replaces this one. Asked once the sandbox spoke, or after `dispose`, it never calls
     * `onSilent`. The returned stop ends the deadline, is safe to call more than once and does nothing once a later ask
     * replaced it. Call it from outside the watch's own listeners and `onSilent`: from inside them the ask queues, and
     * the returned stop does nothing or ends an older deadline. Never throws: a throw of `onSilent` is reported.
     */
    expectHeardWithin,
    /**
     * Stops listening and drops a running deadline, so a later message delivers nothing and the deadline never calls
     * `onSilent`. Safe to call again. Never throws: a throw of the unsubscribe `channel.on` returned is reported.
     */
    dispose,
  };

  function subscribeOutcomes(listener: (report: SandboxLoadReport) => void): () => void {
    const state = load.state.get();
    if (state.kind === 'ended') {
      outcomes.deliver(listener, state.latest);
    }
    return outcomes.subscribe(listener);
  }

  function subscribeCleared(listener: () => void): () => void {
    switch (load.state.get().kind) {
      case 'cleared':
      case 'ended':
        clears.deliver(listener, undefined);
        return noop;
      case 'idle':
      case 'unheard':
      case 'heard':
      case 'disposed':
        break;
    }
    const unsubscribe = clears.subscribe(() => {
      unsubscribe();
      listener();
    });
    return unsubscribe;
  }

  function expectHeardWithin({ onSilent, silenceMs = SANDBOX_SILENCE_MS }: ExpectHeardWithinParams): () => void {
    load.update({ kind: 'deadlineAsked', onSilent, silenceMs });
    const state = load.state.get();
    if (state.kind !== 'unheard' || state.deadline.kind !== 'running') {
      return noop;
    }
    const { timer } = state.deadline;
    return () => {
      load.update({ kind: 'deadlineStopped', timer });
    };
  }

  function dispose(): void {
    load.update({ kind: 'disposed' });
  }

  function clearDeadline(deadline: Deadline): void {
    if (deadline.kind === 'running') {
      timers.clearTimeout(deadline.timer);
    }
  }
}

/** The sandbox frame said nothing within its deadline. */
export class SandboxSilentError extends Error {
  constructor(silenceMs: number) {
    super(`The app frame sent nothing within ${String(silenceMs / 1000)}s`);
    this.name = 'SandboxSilentError';
  }
}

function toTagStep(step: string | undefined): string | undefined {
  return step !== undefined && FAILED_STEP_RE.test(step) ? step : undefined;
}
