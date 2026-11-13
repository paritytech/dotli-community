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
  timers?: Pick<Timers, 'setTimeout'> | undefined;
};

/** One call of `expectHeardWithin`. Its identity tells its own deadline from a later one. */
type Ask = {
  /** Hears the sandbox's silence once the deadline passes with nothing heard. */
  onSilent: (error: SandboxSilentError) => void;
};

/**
 * Each listening state holds the channel's unsubscribe. `idle` stays when the channel could not be listened to. A
 * deadline that ends leaves the sandbox `unheard` again. A deadline's timer is never cleared: once its ask left the
 * state, it ends nothing.
 */
type SandboxLoadState =
  | { kind: 'idle' }
  | { kind: 'unheard'; stopListening: () => void }
  | { kind: 'waiting'; stopListening: () => void; ask: Ask }
  | { kind: 'heard'; stopListening: () => void }
  | { kind: 'cleared'; stopListening: () => void; latest: SandboxLoadReport | null }
  | { kind: 'disposed' };

type SandboxLoadEvent =
  | { kind: 'started' }
  | { kind: 'spoke' }
  /** `report` is the outcome the `done` carried, if any. */
  | { kind: 'doneHeard'; report: SandboxLoadReport | null }
  | { kind: 'deadlineAsked'; ask: Ask }
  | { kind: 'deadlinePassed'; ask: Ask }
  | { kind: 'deadlineStopped'; ask: Ask }
  | { kind: 'disposed' };

type SandboxLoadEffect =
  { kind: 'cleared' } | { kind: 'outcome'; report: SandboxLoadReport } | { kind: 'silent'; ask: Ask };

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
  /** Moves a sandbox that speaks for the first time on. */
  const hearSpeech: HandlerOf<SandboxLoadMachine, 'unheard' | 'waiting', 'spoke'> = (
    { stopListening },
    _event,
    { emitState },
  ) => {
    emitState({ kind: 'heard', stopListening });
  };
  /** Clears the screen at the sandbox's first `done`, and ends the load in `cleared` when the `done` carries an outcome. */
  const clearScreen: HandlerOf<SandboxLoadMachine, 'unheard' | 'waiting' | 'heard', 'doneHeard'> = (
    { stopListening },
    event,
    { emitState, emitSideEffect, update },
  ) => {
    emitState({ kind: 'cleared', stopListening, latest: null });
    emitSideEffect({ kind: 'cleared' });
    // After the clear's listeners, so one that follows the outcomes from there hears this one once.
    update(event);
  };
  /** Starts the ask's deadline in place of any earlier one. */
  const startDeadline: HandlerOf<SandboxLoadMachine, 'unheard' | 'waiting', 'deadlineAsked'> = (
    { stopListening },
    { ask },
    { emitState, update },
  ) => {
    emitState({ kind: 'waiting', stopListening, ask });
    timers.setTimeout(() => {
      update({ kind: 'deadlinePassed', ask });
    }, SANDBOX_SILENCE_MS);
  };
  /** Stops listening, so nothing the sandbox says later counts, and a deadline left running ends nothing. */
  const stop: HandlerOf<SandboxLoadMachine, 'unheard' | 'waiting' | 'heard' | 'cleared', 'disposed'> = (
    { stopListening },
    _event,
    { emitState },
  ) => {
    emitState({ kind: 'disposed' });
    stopListening();
  };
  const load = createStateMachine<SandboxLoadMachine>({
    initial: { kind: 'idle' },
    handlers: {
      idle: {
        started(_state, _event, { emitState, update }) {
          const stopListening = channel.on('dotli:loading-status', status => {
            update(status.done === true ? { kind: 'doneHeard', report: toReport(status) } : { kind: 'spoke' });
          });
          emitState({ kind: 'unheard', stopListening });
        },
      },
      unheard: { spoke: hearSpeech, doneHeard: clearScreen, deadlineAsked: startDeadline, disposed: stop },
      waiting: {
        spoke: hearSpeech,
        doneHeard: clearScreen,
        deadlineAsked: startDeadline,
        deadlinePassed({ stopListening, ask }, event, { emitState, emitSideEffect }) {
          if (event.ask !== ask) {
            return;
          }
          emitState({ kind: 'unheard', stopListening });
          emitSideEffect({ kind: 'silent', ask });
        },
        deadlineStopped({ stopListening, ask }, event, { emitState }) {
          if (event.ask !== ask) {
            return;
          }
          emitState({ kind: 'unheard', stopListening });
        },
        disposed: stop,
      },
      heard: { doneHeard: clearScreen, disposed: stop },
      cleared: {
        doneHeard(state, { report }, { emitState, emitSideEffect }) {
          // A `done` without an outcome only clears the screen for a prompt the sandbox shows before its content loads.
          if (report === null) {
            return;
          }
          emitState({ ...state, latest: report });
          emitSideEffect({ kind: 'outcome', report });
        },
        disposed: stop,
      },
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
          effect.ask.onSilent(new SandboxSilentError(SANDBOX_SILENCE_MS));
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
     * Gives the sandbox 30 seconds from the call to speak, and calls `onSilent` with a `SandboxSilentError` when it
     * stays silent. A later ask replaces this one. Asked once the sandbox spoke, or after `dispose`, it never calls
     * `onSilent`. The returned stop ends this deadline, is safe to call more than once and does nothing once a later
     * ask replaced it. Never throws: a throw of `onSilent` is reported.
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
    if (state.kind === 'cleared' && state.latest !== null) {
      outcomes.deliver(listener, state.latest);
    }
    return outcomes.subscribe(listener);
  }

  function subscribeCleared(listener: () => void): () => void {
    if (load.state.get().kind === 'cleared') {
      clears.deliver(listener, undefined);
      return noop;
    }
    // The watch clears the screen once, so a listener subscribed now hears it once.
    return clears.subscribe(listener);
  }

  function expectHeardWithin({ onSilent }: Ask): () => void {
    // A new object, so an ask with the same `onSilent` as an earlier one is still told from it.
    const ask = { onSilent };
    load.update({ kind: 'deadlineAsked', ask });
    return () => {
      load.update({ kind: 'deadlineStopped', ask });
    };
  }

  function dispose(): void {
    load.update({ kind: 'disposed' });
  }
}

/** The sandbox frame said nothing within its deadline. */
export class SandboxSilentError extends Error {
  constructor(silenceMs: number) {
    super(`The app frame sent nothing within ${String(silenceMs / 1000)}s`);
    this.name = 'SandboxSilentError';
  }
}

/** The outcome a `done` carries, its failed step cleaned for a tag, or `null` when it carries none. */
function toReport({
  outcome,
  failedStep,
}: {
  outcome?: SandboxLoadOutcome;
  failedStep?: string;
}): SandboxLoadReport | null {
  if (outcome === undefined) {
    return null;
  }
  if (isLoadedOutcome(outcome) || failedStep === undefined || !FAILED_STEP_RE.test(failedStep)) {
    return { outcome, failedStep: undefined };
  }
  return { outcome, failedStep };
}
