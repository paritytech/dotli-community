// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createStateMachine, type HandlerOf, type HandlersOf, type MachineTypes } from './createStateMachine.js';
import { rejectUnhandled } from './rejectUnhandled.js';

type Params<T> = {
  load: () => Promise<T>;
  onFirstMiss?: (error: unknown) => void;
};

/** `asker` is the token of the call whose ask started the load, so its failure goes to that caller only. */
type LoadState<T> =
  | { kind: 'unloaded' }
  | { kind: 'loading'; asker: symbol; missedBefore: boolean }
  | { kind: 'loaded'; value: T }
  | { kind: 'missed'; asker: symbol; error: unknown };

type LoadEvent<T> =
  { kind: 'asked'; asker: symbol } | { kind: 'valueLoaded'; value: T } | { kind: 'loadFailed'; error: unknown };

type LoadEffect = { kind: 'firstMissed'; error: unknown };

type LoadMachine<T> = MachineTypes<LoadState<T>, LoadEvent<T>, LoadEffect>;

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
  const startLoad: HandlerOf<LoadMachine<T>, 'unloaded' | 'missed', 'asked'> = (
    state,
    { asker },
    { emitState, update },
  ) => {
    emitState({ kind: 'loading', asker, missedBefore: state.kind === 'missed' });
    update(
      // A `load` that throws before it returns a promise rejects this one, so its error reaches the caller too.
      new Promise<T>(resolve => {
        resolve(load());
      }).then(
        value => ({ kind: 'valueLoaded', value }),
        (error: unknown) => ({ kind: 'loadFailed', error }),
      ),
    );
  };
  // An `asked` here is ignored: that caller waits for the load in flight.
  const loading: HandlersOf<LoadMachine<T>, 'loading'> = {
    valueLoaded(_state, { value }, { emitState }) {
      emitState({ kind: 'loaded', value });
    },
    loadFailed({ asker, missedBefore }, { error }, { emitState, emitSideEffect }) {
      emitState({ kind: 'missed', asker, error });
      if (!missedBefore) {
        emitSideEffect({ kind: 'firstMissed', error });
      }
    },
  };
  const machine = createStateMachine<LoadMachine<T>>({
    initial: { kind: 'unloaded' },
    handlers: {
      unloaded: { asked: startLoad },
      loading,
      loaded: null,
      missed: { asked: startLoad },
    },
    onEffect: ({ error }) => {
      onFirstMiss?.(error);
    },
    onError: rejectUnhandled,
  });

  return getValue;

  async function getValue(): Promise<T> {
    const asker = Symbol('asker');
    // Waiters wake in the order they called `await()`. A caller that woke after another one's failure, or after
    // another waiter started the next load, asks again and waits on that load.
    for (;;) {
      machine.update({ kind: 'asked', asker });
      await machine.await();
      const settled = machine.state.get();
      switch (settled.kind) {
        case 'loaded':
          return settled.value;
        case 'missed':
          if (settled.asker === asker) {
            throw settled.error;
          }
          continue;
        // No waiter wakes to `unloaded`, since its own ask left it.
        case 'unloaded':
        case 'loading':
          continue;
      }
    }
  }
}
