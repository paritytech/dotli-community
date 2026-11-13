// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createDeferred } from './createDeferred.js';
import { createStateMachine, type MachineTypes } from './createStateMachine.js';
import { rejectUnhandled } from './rejectUnhandled.js';

type Params<T> = {
  load: () => Promise<T>;
  onFirstMiss?: (error: unknown) => void;
};

type Caller<T> = ReturnType<typeof createDeferred<T>>;

/**
 * `missed` is true once a load has failed. `asker` is the caller whose ask started the load in flight, so its failure
 * goes to that caller only, and `queued` wait behind it in the order they asked.
 */
type LoadState<T> =
  | { kind: 'unloaded'; missed: boolean }
  | { kind: 'loading'; asker: Caller<T>; queued: readonly Caller<T>[]; missed: boolean }
  | { kind: 'loaded'; value: T };

type LoadEvent<T> =
  { kind: 'asked'; caller: Caller<T> } | { kind: 'valueLoaded'; value: T } | { kind: 'loadFailed'; error: unknown };

type LoadEffect<T> =
  | { kind: 'resolve'; callers: readonly Caller<T>[]; value: T }
  | { kind: 'reject'; caller: Caller<T>; error: unknown }
  | { kind: 'firstMissed'; error: unknown };

type LoadMachine<T> = MachineTypes<LoadState<T>, LoadEvent<T>, LoadEffect<T>>;

/**
 * Loads a value on the first call and keeps it for every later one. A failed load rejects the caller that ran it and is
 * not kept, so the next caller, queued behind it or later, loads again itself. `onFirstMiss` hears the first failure
 * of this loader only, so a chunk a deploy removed is reported once.
 *
 * @example
 * const getRuntime = createLazyLoad({ load: () => import('./runtime.js') });
 * const runtime = await getRuntime(); // later calls get the kept value
 */
export function createLazyLoad<T>({ load, onFirstMiss }: Params<T>): () => Promise<T> {
  const machine = createStateMachine<LoadMachine<T>>({
    initial: { kind: 'unloaded', missed: false },
    handlers: {
      unloaded: {
        asked({ missed }, { caller }, { emitState, update }) {
          emitState({ kind: 'loading', asker: caller, queued: [], missed });
          update(runLoad());
        },
      },
      loading: {
        asked(state, { caller }, { emitState }) {
          emitState({ ...state, queued: [...state.queued, caller] });
        },
        valueLoaded({ asker, queued }, { value }, { emitState, emitSideEffect }) {
          emitState({ kind: 'loaded', value });
          emitSideEffect({ kind: 'resolve', callers: [asker, ...queued], value });
        },
        loadFailed({ asker, queued, missed }, { error }, { emitState, emitSideEffect, update }) {
          emitSideEffect({ kind: 'reject', caller: asker, error });
          if (!missed) {
            emitSideEffect({ kind: 'firstMissed', error });
          }
          const [next, ...rest] = queued;
          if (next === undefined) {
            emitState({ kind: 'unloaded', missed: true });
            return;
          }
          emitState({ kind: 'loading', asker: next, queued: rest, missed: true });
          update(runLoad());
        },
      },
      loaded: {
        asked({ value }, { caller }, { emitSideEffect }) {
          emitSideEffect({ kind: 'resolve', callers: [caller], value });
        },
      },
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'resolve':
          for (const caller of effect.callers) {
            caller.resolve(effect.value);
          }
          return;
        case 'reject':
          effect.caller.reject(effect.error);
          return;
        case 'firstMissed':
          onFirstMiss?.(effect.error);
          return;
      }
    },
    onError: rejectUnhandled,
  });

  return () => {
    const caller = createDeferred<T>();
    machine.update({ kind: 'asked', caller });
    return caller.promise;
  };

  function runLoad(): Promise<LoadEvent<T>> {
    // A `load` that throws before it returns a promise rejects this one, so its error reaches the caller too.
    return new Promise<T>(resolve => {
      resolve(load());
    }).then(
      value => ({ kind: 'valueLoaded', value }),
      (error: unknown) => ({ kind: 'loadFailed', error }),
    );
  }
}
