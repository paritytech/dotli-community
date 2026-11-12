// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createReporter, defineCount } from '@dotli/metrics';
import { createStateMachine, type HandlerOf, type MachineTypes, type Transition } from '@dotli/shared';
import { toBlockingModalAbortError } from './throwIfModalAborted.js';

const report = createReporter({ flow: 'ui' });

/** A blocking-modal queue's transition, or its counts report, that threw. Tagged `outcome` (error). */
const blockingModalTransitionMetric = defineCount<'error'>('blocking_modal.transition');

/** Keeps the prompt slot taken until `promise` settles. Call it before the task returns. */
export type HoldSlot = (promise: Promise<unknown>) => void;

type BlockingModalTask<T> = (signal: AbortSignal, hold: HoldSlot) => Promise<T> | T;

/** Prompts queued behind the one on screen, and whether one is up. */
export type BlockingModalCounts = {
  waiting: number;
  active: boolean;
};

type Params = {
  /** Hears the counts after every change, so the page can show how busy the queue is. */
  report?: ((counts: BlockingModalCounts) => void) | undefined;
};

/**
 * One prompt of the scope `signal` belongs to. `run` runs its task with its answer typed at enqueue: it settles with a
 * call that resolves the caller's promise.
 */
type Prompt = {
  signal: AbortSignal;
  run: (signal: AbortSignal, hold: HoldSlot) => Promise<() => void>;
  reject: (error: unknown) => void;
};

/**
 * `shown` while the prompt's task runs, `holding` the slot past its answer, each with the prompts waiting behind it,
 * oldest first.
 */
type CoordinatorState =
  | { kind: 'idle' }
  | { kind: 'shown'; prompt: Prompt; holds: number; queue: readonly Prompt[] }
  | { kind: 'holding'; prompt: Prompt; holds: number; queue: readonly Prompt[] };

type CoordinatorEvent =
  | { kind: 'enqueued'; prompt: Prompt }
  | { kind: 'answered'; prompt: Prompt; answer: () => void }
  | { kind: 'taskFailed'; prompt: Prompt; error: unknown }
  | { kind: 'held'; prompt: Prompt; promise: Promise<unknown> }
  | { kind: 'holdSettled'; prompt: Prompt }
  | { kind: 'scopeAborted'; signal: AbortSignal };

type CoordinatorEffect =
  | { kind: 'runTask'; prompt: Prompt }
  | { kind: 'answer'; answer: () => void }
  | { kind: 'reject'; reject: (error: unknown) => void; error: unknown }
  | { kind: 'countsChanged'; counts: BlockingModalCounts };

type CoordinatorMachine = MachineTypes<CoordinatorState, CoordinatorEvent, CoordinatorEffect>;

export type BlockingModalCoordinator = ReturnType<typeof createBlockingModalCoordinator>;

export type BlockingModalScope = ReturnType<BlockingModalCoordinator['createScope']>;

/** One prompt on screen at a time, across every scope. `report` hears how many wait and whether one shows. */
export function createBlockingModalCoordinator({ report: reportCounts = () => undefined }: Params = {}) {
  const machine = createStateMachine<CoordinatorMachine>({
    initial: { kind: 'idle' },
    handlers: {
      idle: {
        enqueued(state, { prompt }, transition) {
          showNext(state, [prompt], transition);
        },
      },
      shown: {
        enqueued: queuePrompt,
        answered(state, { prompt, answer }, transition) {
          if (prompt !== state.prompt) {
            return;
          }
          if (state.holds > 0) {
            transition.emitState({ ...state, kind: 'holding' });
          } else {
            showNext(state, state.queue, transition);
          }
          transition.emitSideEffect({ kind: 'answer', answer });
        },
        taskFailed(state, { prompt, error }, transition) {
          if (prompt !== state.prompt) {
            return;
          }
          showNext(state, state.queue, transition);
          transition.emitSideEffect({ kind: 'reject', reject: prompt.reject, error });
        },
        held: holdSlot,
        holdSettled(state, { prompt }, { emitState }) {
          if (prompt !== state.prompt) {
            return;
          }
          emitState({ ...state, holds: state.holds - 1 });
        },
        scopeAborted: abortScope,
      },
      holding: {
        enqueued: queuePrompt,
        held: holdSlot,
        holdSettled(state, { prompt }, transition) {
          if (prompt !== state.prompt) {
            return;
          }
          if (state.holds > 1) {
            transition.emitState({ ...state, holds: state.holds - 1 });
            return;
          }
          showNext(state, state.queue, transition);
        },
        scopeAborted: abortScope,
      },
    },
    onEffect(effect) {
      switch (effect.kind) {
        case 'runTask': {
          const { prompt } = effect;
          // A report of the counts runs just before, and may have disposed the scope. Its `scopeAborted` is next.
          if (prompt.signal.aborted) {
            return;
          }
          machine.update(
            prompt
              .run(prompt.signal, promise => {
                machine.update({ kind: 'held', prompt, promise });
              })
              .then(
                answer => ({ kind: 'answered', prompt, answer }),
                (error: unknown) => ({ kind: 'taskFailed', prompt, error }),
              ),
          );
          return;
        }
        case 'answer':
          effect.answer();
          return;
        case 'reject':
          effect.reject(effect.error);
          return;
        case 'countsChanged':
          // Reported apart from the transition, so a throw from `report`, or from a listener of a store it sets, finds
          // the prompt already moved and its caller settled.
          try {
            reportCounts(effect.counts);
          } catch (error) {
            report.defect(error, {
              step: 'counts',
              metric: blockingModalTransitionMetric,
              message: '[dot.li] A blocking modal counts report threw',
            });
          }
          return;
      }
    },
    onError(error) {
      report.defect(error, {
        step: 'transition',
        metric: blockingModalTransitionMetric,
        message: '[dot.li] A blocking modal queue transition threw',
      });
    },
  });

  return {
    /** Returns a new scope, whose prompts queue with every other scope's. Never throws. */
    createScope() {
      const controller = new AbortController();
      const { signal } = controller;
      signal.addEventListener(
        'abort',
        () => {
          machine.update({ kind: 'scopeAborted', signal });
        },
        { once: true },
      );
      return {
        /**
         * Resolves with the task's value as soon as it returns. A promise the task holds keeps the slot, and the
         * counts, taken until it settles or the scope is disposed, so no other prompt covers what it shows. Rejects
         * with an AbortError when the scope is disposed before the task answers, so a caller must handle it.
         */
        enqueue<T>(task: BlockingModalTask<T>): Promise<T> {
          if (signal.aborted) {
            return Promise.reject(toBlockingModalAbortError(signal.reason));
          }
          return new Promise<T>((resolve, reject) => {
            const run: Prompt['run'] = (taskSignal, hold) =>
              new Promise<T>(settle => {
                settle(task(taskSignal, hold));
              }).then(value => () => {
                resolve(value);
              });
            machine.update({ kind: 'enqueued', prompt: { signal, run, reject } });
          });
        },
        /** Ends the scope's prompts with an AbortError that carries `reason`. Idempotent, and never throws. */
        dispose(reason = 'TrUAPI host disposed'): void {
          if (!signal.aborted) {
            controller.abort(toBlockingModalAbortError(reason));
          }
        },
      };
    },
  };
}

const queuePrompt: HandlerOf<CoordinatorMachine, 'shown' | 'holding', 'enqueued'> = (state, { prompt }, transition) => {
  emitCounted(state, { ...state, queue: [...state.queue, prompt] }, transition);
};

const holdSlot: HandlerOf<CoordinatorMachine, 'shown' | 'holding', 'held'> = (
  state,
  { prompt, promise },
  transition,
) => {
  if (prompt !== state.prompt) {
    return;
  }
  transition.emitState({ ...state, holds: state.holds + 1 });
  // A held step reports its own failure, so only its end matters here.
  transition.update(
    promise.then(
      () => ({ kind: 'holdSettled', prompt }),
      () => ({ kind: 'holdSettled', prompt }),
    ),
  );
};

/** Ends the scope's prompts: the one up, if it is the scope's, and those waiting. */
const abortScope: HandlerOf<CoordinatorMachine, 'shown' | 'holding', 'scopeAborted'> = (
  state,
  { signal },
  transition,
) => {
  const error = toBlockingModalAbortError(signal.reason);
  const ended = state.prompt.signal === signal;
  if (ended && state.kind === 'shown') {
    transition.emitSideEffect({ kind: 'reject', reject: state.prompt.reject, error });
  }
  const queue: Prompt[] = [];
  for (const prompt of state.queue) {
    if (prompt.signal === signal) {
      transition.emitSideEffect({ kind: 'reject', reject: prompt.reject, error });
    } else {
      queue.push(prompt);
    }
  }
  if (ended) {
    showNext(state, queue, transition);
    return;
  }
  emitCounted(state, { ...state, queue }, transition);
};

/** Shows the first of `queue` and runs its task once the counts it changes are reported, or goes idle on none. */
function showNext(state: CoordinatorState, queue: readonly Prompt[], transition: Transition<CoordinatorMachine>): void {
  const [prompt, ...rest] = queue;
  if (prompt === undefined) {
    emitCounted(state, { kind: 'idle' }, transition);
    return;
  }
  emitCounted(state, { kind: 'shown', prompt, holds: 0, queue: rest }, transition);
  transition.emitSideEffect({ kind: 'runTask', prompt });
}

/** Moves to `next`, and tells the bar when the counts change. */
function emitCounted(
  state: CoordinatorState,
  next: CoordinatorState,
  { emitState, emitSideEffect }: Transition<CoordinatorMachine>,
): void {
  emitState(next);
  const before = countPrompts(state);
  const after = countPrompts(next);
  if (before.waiting !== after.waiting || before.active !== after.active) {
    emitSideEffect({ kind: 'countsChanged', counts: after });
  }
}

/** The one up and those waiting count together, so the bar never reads idle between two that follow each other. */
function countPrompts(state: CoordinatorState): BlockingModalCounts {
  switch (state.kind) {
    case 'idle':
      return { waiting: 0, active: false };
    case 'shown':
    case 'holding':
      return { waiting: state.queue.length, active: true };
  }
}
