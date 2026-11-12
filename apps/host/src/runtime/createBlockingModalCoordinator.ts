// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createReporter, defineCount } from '@dotli/metrics';
import {
  createAsyncTaskPool,
  createStateMachine,
  nest,
  type HandlerOf,
  type MachineTypes,
  type Transition,
} from '@dotli/shared';
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

/** The prompt's task with its answer typed at enqueue: it settles with a call that resolves the caller's promise. */
type PromptRun = (signal: AbortSignal, hold: HoldSlot) => Promise<() => void>;

/**
 * One prompt: `waiting` for its slot, `shown` while its task runs, `holding` the slot past its answer. `done` frees its
 * slot in the pool, and `stopAbort` stops hearing its scope's abort.
 */
type Prompt =
  | { kind: 'waiting'; signal: AbortSignal; run: PromptRun; reject: (error: unknown) => void; stopAbort: () => void }
  | {
      kind: 'shown';
      signal: AbortSignal;
      run: PromptRun;
      reject: (error: unknown) => void;
      stopAbort: () => void;
      done: () => void;
      holds: number;
    }
  | { kind: 'holding'; stopAbort: () => void; done: () => void; holds: number }
  | { kind: 'settled' };

/** A settled prompt leaves the map, so `prompts` holds the shown and waiting ones, oldest first. */
type CoordinatorState = { kind: 'running'; prompts: ReadonlyMap<symbol, Exclude<Prompt, { kind: 'settled' }>> };

type CoordinatorEvent =
  | { kind: 'enqueued'; id: symbol; prompt: Extract<Prompt, { kind: 'waiting' }> }
  | { kind: 'promptShown'; id: symbol; done: () => void }
  | { kind: 'taskStarted'; id: symbol }
  | { kind: 'answered'; id: symbol; answer: () => void }
  | { kind: 'taskFailed'; id: symbol; error: unknown }
  | { kind: 'held'; id: symbol; promise: Promise<unknown> }
  | { kind: 'holdSettled'; id: symbol }
  | { kind: 'promptAborted'; id: symbol };

/** A prompt came, moved between `waiting`, `shown` and `holding`, or left, so the counts may have changed. */
type CoordinatorEffect = { kind: 'countsChanged' };

type CoordinatorMachine = MachineTypes<CoordinatorState, CoordinatorEvent, CoordinatorEffect>;

type PromptMachine = MachineTypes<Prompt, CoordinatorEvent, CoordinatorEffect>;

export type BlockingModalCoordinator = ReturnType<typeof createBlockingModalCoordinator>;

export type BlockingModalScope = ReturnType<BlockingModalCoordinator['createScope']>;

/** One prompt on screen at a time, across every scope. `report` hears how many wait and whether one shows. */
export function createBlockingModalCoordinator({ report: reportCounts = () => undefined }: Params = {}) {
  const prompts = createAsyncTaskPool({ poolSize: 1 });

  const holdSlot: HandlerOf<PromptMachine, 'shown' | 'holding', 'held'> = (
    prompt,
    { id, promise },
    { emitState, update },
  ) => {
    emitState({ ...prompt, holds: prompt.holds + 1 });
    // A held step reports its own failure, so only its end matters here.
    update(
      promise.then(
        () => ({ kind: 'holdSettled', id }),
        () => ({ kind: 'holdSettled', id }),
      ),
    );
  };
  const abortPrompt: HandlerOf<PromptMachine, 'waiting' | 'shown', 'promptAborted'> = (prompt, _event, transition) => {
    leave(prompt, transition);
    prompt.reject(toBlockingModalAbortError(prompt.signal.reason));
  };

  const handlePrompt = nest<
    CoordinatorMachine,
    'running',
    PromptMachine,
    'taskStarted' | 'answered' | 'taskFailed' | 'held' | 'holdSettled' | 'promptAborted'
  >({
    find: (state, { id }) => state.prompts.get(id) ?? null,
    store(state, { id }, next) {
      const open = new Map(state.prompts);
      switch (next.kind) {
        case 'waiting':
        case 'shown':
        case 'holding':
          open.set(id, next);
          break;
        case 'settled':
          open.delete(id);
          break;
      }
      return { ...state, prompts: open };
    },
    handlers: {
      waiting: { promptAborted: abortPrompt },
      shown: {
        taskStarted(prompt, { id }, transition) {
          const { signal, run, reject } = prompt;
          const { update } = transition;
          // A report of the counts runs between the prompt's showing and this event, and may have disposed the scope.
          if (signal.aborted) {
            leave(prompt, transition);
            reject(toBlockingModalAbortError(signal.reason));
            return;
          }
          update(
            run(signal, promise => {
              update({ kind: 'held', id, promise });
            }).then(
              answer => ({ kind: 'answered', id, answer }),
              (error: unknown) => ({ kind: 'taskFailed', id, error }),
            ),
          );
        },
        held: holdSlot,
        answered(prompt, { answer }, transition) {
          const { stopAbort, done, holds } = prompt;
          if (holds > 0) {
            transition.emitState({ kind: 'holding', stopAbort, done, holds });
            transition.emitSideEffect({ kind: 'countsChanged' });
          } else {
            leave(prompt, transition);
          }
          answer();
        },
        taskFailed(prompt, { error }, transition) {
          leave(prompt, transition);
          prompt.reject(error);
        },
        holdSettled(prompt, _event, { emitState }) {
          emitState({ ...prompt, holds: prompt.holds - 1 });
        },
        promptAborted: abortPrompt,
      },
      holding: {
        held: holdSlot,
        holdSettled(prompt, _event, transition) {
          if (prompt.holds > 1) {
            transition.emitState({ ...prompt, holds: prompt.holds - 1 });
            return;
          }
          leave(prompt, transition);
        },
        promptAborted(prompt, _event, transition) {
          leave(prompt, transition);
        },
      },
      settled: null,
    },
  });

  let reported: BlockingModalCounts | null = null;
  const machine = createStateMachine<CoordinatorMachine>({
    initial: { kind: 'running', prompts: new Map() },
    handlers: {
      running: {
        enqueued(state, { id, prompt }, { emitState, emitSideEffect, update }) {
          emitState({ ...state, prompts: new Map(state.prompts).set(id, prompt) });
          emitSideEffect({ kind: 'countsChanged' });
          prompts
            .call(
              () =>
                new Promise<void>(done => {
                  update({ kind: 'promptShown', id, done });
                }),
              { signal: prompt.signal },
            )
            .catch((error: unknown) => {
              // `promptAborted` already turned the scope's abort into the prompt's end.
              if (error === prompt.signal.reason) {
                return;
              }
              report.defect(error, {
                step: 'transition',
                metric: blockingModalTransitionMetric,
                message: '[dot.li] A blocking modal prompt slot failed',
              });
            });
        },
        promptShown(state, { id, done }, { emitState, emitSideEffect, update }) {
          const prompt = state.prompts.get(id);
          if (prompt?.kind !== 'waiting') {
            done();
            return;
          }
          emitState({
            ...state,
            prompts: new Map(state.prompts).set(id, { ...prompt, kind: 'shown', done, holds: 0 }),
          });
          emitSideEffect({ kind: 'countsChanged' });
          // Sent, not run here, so an abort the scope's holder sends meanwhile is heard before the task runs.
          update({ kind: 'taskStarted', id });
        },
        taskStarted: handlePrompt,
        answered: handlePrompt,
        taskFailed: handlePrompt,
        held: handlePrompt,
        holdSettled: handlePrompt,
        promptAborted: handlePrompt,
      },
    },
    // Runs after the transition's emits, so a throw from `report`, or from a listener of a store it sets, finds the
    // prompt already moved and its caller settled.
    onEffect() {
      const open = machine.state.get().prompts;
      // Shown and waiting prompts together, so the bar never reads idle between two that follow each other.
      const counts: BlockingModalCounts = {
        waiting: [...open.values()].filter(prompt => prompt.kind === 'waiting').length,
        active: open.size > 0,
      };
      if (reported?.waiting === counts.waiting && reported.active === counts.active) {
        return;
      }
      reported = counts;
      try {
        reportCounts(counts);
      } catch (error) {
        report.defect(error, {
          step: 'counts',
          metric: blockingModalTransitionMetric,
          message: '[dot.li] A blocking modal counts report threw',
        });
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

  function enqueue<T>(signal: AbortSignal, task: BlockingModalTask<T>): Promise<T> {
    if (signal.aborted) {
      return Promise.reject(toBlockingModalAbortError(signal.reason));
    }
    return new Promise<T>((resolve, reject) => {
      const id = Symbol('prompt');
      function abort(): void {
        machine.update({ kind: 'promptAborted', id });
      }
      // Ahead of the pool's own abort listener, so the counts drop before the pool moves on. A later prompt of the same
      // scope can still be started then, and its abort is heard before its task runs.
      signal.addEventListener('abort', abort, { once: true });
      machine.update({
        kind: 'enqueued',
        id,
        prompt: {
          kind: 'waiting',
          signal,
          run: (taskSignal, hold) =>
            new Promise<T>(settle => {
              settle(task(taskSignal, hold));
            }).then(value => () => {
              resolve(value);
            }),
          reject,
          stopAbort() {
            signal.removeEventListener('abort', abort);
          },
        },
      });
    });
  }

  return {
    /** Returns a new scope, whose prompts queue with every other scope's. Never throws. */
    createScope() {
      const controller = new AbortController();
      return {
        /**
         * Resolves with the task's value as soon as it returns. A promise the task holds keeps the slot, and the
         * counts, taken until it settles or the scope is disposed, so no other prompt covers what it shows. Rejects
         * with an AbortError when the scope is disposed before the task answers, so a caller must handle it.
         */
        enqueue<T>(task: BlockingModalTask<T>): Promise<T> {
          return enqueue(controller.signal, task);
        },
        /** Ends the scope's prompts with an AbortError that carries `reason`. Idempotent, and never throws. */
        dispose(reason = 'TrUAPI host disposed'): void {
          if (!controller.signal.aborted) {
            controller.abort(toBlockingModalAbortError(reason));
          }
        },
      };
    },
  };
}

/** Ends a prompt: it leaves the map, stops hearing its scope's abort, and frees its slot when it has one. */
function leave(
  prompt: Exclude<Prompt, { kind: 'settled' }>,
  { emitState, emitSideEffect }: Pick<Transition<PromptMachine>, 'emitState' | 'emitSideEffect'>,
): void {
  emitState({ kind: 'settled' });
  emitSideEffect({ kind: 'countsChanged' });
  prompt.stopAbort();
  if (prompt.kind !== 'waiting') {
    prompt.done();
  }
}
