// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createReporter, defineCount } from '@dotli/metrics';
import { createAsyncTaskPool, createStateMachine, type MachineTypes, type Transition } from '@dotli/shared';
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
 * One prompt of the scope that `signal` belongs to: `waiting` for its slot, `shown` while its task runs, `holding` the
 * slot past its answer. `done` frees its slot in the pool.
 */
type Prompt =
  | { kind: 'waiting'; signal: AbortSignal; run: PromptRun; reject: (error: unknown) => void }
  | {
      kind: 'shown';
      signal: AbortSignal;
      run: PromptRun;
      reject: (error: unknown) => void;
      done: () => void;
      holds: number;
    }
  | { kind: 'holding'; signal: AbortSignal; done: () => void; holds: number };

/** The shown and waiting prompts, oldest first. An ended prompt leaves the map. */
type CoordinatorState = { kind: 'running'; prompts: ReadonlyMap<symbol, Prompt> };

type CoordinatorEvent =
  | { kind: 'enqueued'; id: symbol; prompt: Extract<Prompt, { kind: 'waiting' }> }
  | { kind: 'promptShown'; id: symbol; done: () => void }
  | { kind: 'answered'; id: symbol; answer: () => void }
  | { kind: 'taskFailed'; id: symbol; error: unknown }
  | { kind: 'held'; id: symbol; promise: Promise<unknown> }
  | { kind: 'holdSettled'; id: symbol }
  | { kind: 'scopeAborted'; signal: AbortSignal };

type CoordinatorEffect =
  | { kind: 'askSlot'; id: symbol; signal: AbortSignal }
  | { kind: 'runTask'; id: symbol; signal: AbortSignal; run: PromptRun }
  | { kind: 'answer'; answer: () => void }
  | { kind: 'reject'; reject: (error: unknown) => void; error: unknown }
  | { kind: 'freeSlot'; done: () => void }
  | { kind: 'countsChanged'; counts: BlockingModalCounts };

type CoordinatorMachine = MachineTypes<CoordinatorState, CoordinatorEvent, CoordinatorEffect>;

export type BlockingModalCoordinator = ReturnType<typeof createBlockingModalCoordinator>;

export type BlockingModalScope = ReturnType<BlockingModalCoordinator['createScope']>;

/** One prompt on screen at a time, across every scope. `report` hears how many wait and whether one shows. */
export function createBlockingModalCoordinator({ report: reportCounts = () => undefined }: Params = {}) {
  const slots = createAsyncTaskPool({ poolSize: 1 });
  const machine = createStateMachine<CoordinatorMachine>({
    initial: { kind: 'running', prompts: new Map() },
    handlers: {
      running: {
        enqueued(state, { id, prompt }, transition) {
          emitPrompts(state, new Map(state.prompts).set(id, prompt), transition);
          transition.emitSideEffect({ kind: 'askSlot', id, signal: prompt.signal });
        },
        promptShown(state, { id, done }, transition) {
          const prompt = state.prompts.get(id);
          // The scope's abort already ended the prompt.
          if (prompt?.kind !== 'waiting') {
            transition.emitSideEffect({ kind: 'freeSlot', done });
            return;
          }
          emitPrompts(state, new Map(state.prompts).set(id, { ...prompt, kind: 'shown', done, holds: 0 }), transition);
          transition.emitSideEffect({ kind: 'runTask', id, signal: prompt.signal, run: prompt.run });
        },
        answered(state, { id, answer }, transition) {
          const prompt = state.prompts.get(id);
          if (prompt?.kind !== 'shown') {
            return;
          }
          const { signal, done, holds } = prompt;
          if (holds > 0) {
            emitPrompts(state, new Map(state.prompts).set(id, { kind: 'holding', signal, done, holds }), transition);
          } else {
            emitPrompts(state, without(state.prompts, id), transition);
            transition.emitSideEffect({ kind: 'freeSlot', done });
          }
          transition.emitSideEffect({ kind: 'answer', answer });
        },
        taskFailed(state, { id, error }, transition) {
          const prompt = state.prompts.get(id);
          if (prompt?.kind !== 'shown') {
            return;
          }
          emitPrompts(state, without(state.prompts, id), transition);
          transition.emitSideEffect({ kind: 'freeSlot', done: prompt.done });
          transition.emitSideEffect({ kind: 'reject', reject: prompt.reject, error });
        },
        held(state, { id, promise }, transition) {
          const prompt = state.prompts.get(id);
          if (prompt === undefined || prompt.kind === 'waiting') {
            return;
          }
          emitPrompts(state, new Map(state.prompts).set(id, { ...prompt, holds: prompt.holds + 1 }), transition);
          // A held step reports its own failure, so only its end matters here.
          transition.update(
            promise.then(
              () => ({ kind: 'holdSettled', id }),
              () => ({ kind: 'holdSettled', id }),
            ),
          );
        },
        holdSettled(state, { id }, transition) {
          const prompt = state.prompts.get(id);
          if (prompt === undefined || prompt.kind === 'waiting') {
            return;
          }
          if (prompt.kind === 'holding' && prompt.holds === 1) {
            emitPrompts(state, without(state.prompts, id), transition);
            transition.emitSideEffect({ kind: 'freeSlot', done: prompt.done });
            return;
          }
          emitPrompts(state, new Map(state.prompts).set(id, { ...prompt, holds: prompt.holds - 1 }), transition);
        },
        scopeAborted(state, { signal }, transition) {
          const open = new Map(state.prompts);
          for (const [id, prompt] of state.prompts) {
            if (prompt.signal !== signal) {
              continue;
            }
            open.delete(id);
            if (prompt.kind !== 'waiting') {
              transition.emitSideEffect({ kind: 'freeSlot', done: prompt.done });
            }
            if (prompt.kind !== 'holding') {
              transition.emitSideEffect({
                kind: 'reject',
                reject: prompt.reject,
                error: toBlockingModalAbortError(signal.reason),
              });
            }
          }
          emitPrompts(state, open, transition);
        },
      },
    },
    onEffect(effect) {
      switch (effect.kind) {
        case 'askSlot':
          slots
            .call(
              () =>
                new Promise<void>(done => {
                  machine.update({ kind: 'promptShown', id: effect.id, done });
                }),
              { signal: effect.signal },
            )
            .catch((error: unknown) => {
              // `scopeAborted` already turned the scope's abort into the prompt's end.
              if (error === effect.signal.reason) {
                return;
              }
              report.defect(error, {
                step: 'transition',
                metric: blockingModalTransitionMetric,
                message: '[dot.li] A blocking modal prompt slot failed',
              });
            });
          return;
        case 'runTask': {
          const { id, signal, run } = effect;
          // A report of the counts runs just before, and may have disposed the scope. Its `scopeAborted` is next.
          if (signal.aborted) {
            return;
          }
          machine.update(
            run(signal, promise => {
              machine.update({ kind: 'held', id, promise });
            }).then(
              answer => ({ kind: 'answered', id, answer }),
              (error: unknown) => ({ kind: 'taskFailed', id, error }),
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
        case 'freeSlot':
          effect.done();
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
      // Heard ahead of the pool's own abort listeners, so the counts drop before the pool moves on.
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
            const run: PromptRun = (taskSignal, hold) =>
              new Promise<T>(settle => {
                settle(task(taskSignal, hold));
              }).then(value => () => {
                resolve(value);
              });
            machine.update({
              kind: 'enqueued',
              id: Symbol('prompt'),
              prompt: { kind: 'waiting', signal, run, reject },
            });
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

/** Moves to `prompts`, and tells the bar when the counts change. */
function emitPrompts(
  state: CoordinatorState,
  prompts: ReadonlyMap<symbol, Prompt>,
  { emitState, emitSideEffect }: Transition<CoordinatorMachine>,
): void {
  emitState({ ...state, prompts });
  const before = countPrompts(state.prompts);
  const after = countPrompts(prompts);
  if (before.waiting !== after.waiting || before.active !== after.active) {
    emitSideEffect({ kind: 'countsChanged', counts: after });
  }
}

/** Shown and waiting prompts together, so the bar never reads idle between two that follow each other. */
function countPrompts(prompts: ReadonlyMap<symbol, Prompt>): BlockingModalCounts {
  return {
    waiting: [...prompts.values()].filter(prompt => prompt.kind === 'waiting').length,
    active: prompts.size > 0,
  };
}

function without(prompts: ReadonlyMap<symbol, Prompt>, id: symbol): ReadonlyMap<symbol, Prompt> {
  const open = new Map(prompts);
  open.delete(id);
  return open;
}
