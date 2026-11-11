// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, type ReadableAtom } from 'nanostores';
import { createAsyncTaskPool } from './createAsyncTaskPool.js';

/** The types one machine runs on. `Effect` is `never` for a machine with no side effects. */
export type MachineTypes<State extends { kind: string }, Event extends { kind: string }, Effect = never> = {
  state: State;
  event: Event;
  effect: Effect;
};

/** What a handler may do within one transition. */
export type Transition<Machine extends AnyMachine> = {
  /** Sets the state at once. Throws once the transition has ended. */
  emitState: (next: Machine['state']) => void;
  /** Queues an effect, run after the transition. Throws once the transition has ended. */
  emitSideEffect: (effect: Machine['effect']) => void;
  /**
   * Sends an event to the machine, handled after this transition and its effects. Still works once the transition has
   * ended. Never throws.
   */
  update: (event: Update<Machine>) => void;
};

/**
 * An event, or work that ends in one, such as a read. The machine counts the work as pending until its event is handled.
 */
export type Update<Machine extends AnyMachine> = Machine['event'] | Promise<Machine['event']>;

/**
 * The handlers of the states of `Kind` in `Machine`, keyed by the kind of event they handle. A group typed for several
 * kinds fills the table slot of each of them.
 */
export type HandlersOf<Machine extends AnyMachine, Kind extends Machine['state']['kind']> = {
  [EventKind in Machine['event']['kind']]?: (
    state: Extract<Machine['state'], { kind: Kind }>,
    event: Extract<Machine['event'], { kind: EventKind }>,
    transition: Transition<Machine>,
  ) => Promise<void> | void;
};

/**
 * The handler of events of `EventKind` in the states of `Kind`. A handler typed for several states fills the slot of
 * each of them.
 */
export type HandlerOf<
  Machine extends AnyMachine,
  Kind extends Machine['state']['kind'],
  EventKind extends Machine['event']['kind'],
> = NonNullable<HandlersOf<Machine, Kind>[EventKind]>;

/** Each state's handlers, or `null` for a state that handles no event. */
export type StateHandlers<Machine extends AnyMachine> = {
  [Kind in Machine['state']['kind']]: null | HandlersOf<Machine, Kind>;
};

type AnyMachine = MachineTypes<{ kind: string }, { kind: string }, unknown>;

type Handler<Machine extends AnyMachine> = (
  state: Machine['state'],
  event: Machine['event'],
  transition: Transition<Machine>,
) => Promise<void> | void;

type Params<Machine extends AnyMachine> = {
  initial: Machine['state'];
  handlers: StateHandlers<Machine>;
  /**
   * Hears a handler or an effect that threw or rejected, and an update whose work rejected. MUST NOT throw. The feature
   * wires its reporter here.
   */
  onError: (error: unknown) => void;
} & ([Machine['effect']] extends [never]
  ? { onEffect?: never }
  : {
      /** Runs each effect after the transition that emitted it. A throw goes to `onError`. */
      onEffect: (effect: Machine['effect']) => void;
    });

/**
 * One state that moves only through transitions, each run by the handler of the state it starts in.
 *
 * A handler moves the state at once with `emitState` and queues side effects with `emitSideEffect`. Once the handler
 * settles, its transition ends and `onEffect` runs the effects in the order they were emitted. An effect that throws
 * goes to `onError`, and the next effect still runs. A handler's throw or rejection goes to `onError` after its
 * effects. An event its state has no handler for is ignored.
 *
 * Transitions never overlap. An event sent while a transition or its effects run, from a handler or an effect too,
 * waits until that transition and its effects are done. The state moves inside `update` only when no task holds the
 * machine's one task slot, and a slot frees one microtask after its task ends. Otherwise the state moves later. A
 * handler that never settles holds the machine, and every later event waits behind it.
 *
 * @example
 * type DoorMachine = MachineTypes<DoorState, DoorEvent>;
 *
 * const door = createStateMachine<DoorMachine>({
 *   initial: { kind: 'closed' },
 *   handlers: {
 *     closed: {
 *       open(_state, _event, { emitState }) {
 *         emitState({ kind: 'open' });
 *       },
 *     },
 *     open: null,
 *   },
 *   onError: error => report.defect(error),
 * });
 * door.update({ kind: 'open' });
 */
export function createStateMachine<Machine extends AnyMachine>({
  initial,
  handlers,
  onEffect,
  onError,
}: Params<Machine>) {
  const current = atom<Machine['state']>(initial);
  const state: ReadableAtom<Machine['state']> = current;
  const transitions = createAsyncTaskPool({ poolSize: 1 });
  // Each update from its call until its transition is done, with the work it waits on. A transition sends its own
  // updates before it ends, so this pool is idle only when the machine has nothing pending.
  const updates = createAsyncTaskPool({ poolSize: Number.POSITIVE_INFINITY });

  return {
    /** The current state. A handler's `emitState` moves it. */
    state,
    /**
     * Handles the event, once its work resolves to it when it is a promise, and once every earlier transition and its
     * effects are done. Work that rejects goes to `onError`. Never throws.
     */
    update,
    /**
     * Resolves once nothing is pending: no transition queued or running, and no update waiting on its work. Resolves
     * at once when nothing is. An update sent meanwhile keeps it waiting. Never rejects.
     */
    await(): Promise<void> {
      return updates.settle();
    },
  };

  function update(event: Update<Machine>): void {
    void updates.call(() => (event instanceof Promise ? event.then(transit) : transit(event))).catch(onError);
  }

  function transit(event: Machine['event']): Promise<void> {
    return transitions.call(() => runTransition(event));
  }

  /** Runs the handler for `event` in the current state, then its effects, and settles after them. Never rejects. */
  async function runTransition(event: Machine['event']): Promise<void> {
    const from = current.get();
    const handle = getHandler(from, event);
    if (handle === null) {
      return;
    }
    const transition = createTransition<Machine>({
      setState: next => {
        current.set(next);
      },
      update,
    });
    try {
      // Awaited only when async, so a synchronous handler moves the state and runs its effects inside `update`.
      const returned = handle(from, event, transition.emits);
      if (returned !== undefined) {
        await returned;
      }
    } catch (error) {
      runEffects(transition.end());
      onError(error);
      return;
    }
    runEffects(transition.end());
  }

  function runEffects(effects: readonly Machine['effect'][]): void {
    for (const effect of effects) {
      try {
        onEffect?.(effect);
      } catch (error) {
        onError(error);
      }
    }
  }

  function getHandler(from: Machine['state'], event: Machine['event']): Handler<Machine> | null {
    // A generic `kind` reads as a plain string, and so the table cannot narrow each handler's parameters to the kinds
    // it is keyed by. The machine only calls a handler with the state and the event of its own keys.
    const byEvent = handlers[from.kind as Machine['state']['kind']] as Partial<Record<string, Handler<Machine>>> | null;
    return byEvent?.[event.kind] ?? null;
  }
}

/** One transition's emits, refused once it has ended. */
function createTransition<Machine extends AnyMachine>({
  setState,
  update,
}: {
  setState: (next: Machine['state']) => void;
  update: (event: Update<Machine>) => void;
}) {
  // An open transition takes emits and holds the effects it has queued.
  let phase: { kind: 'open'; effects: Machine['effect'][] } | { kind: 'ended' } = { kind: 'open', effects: [] };

  const emits: Transition<Machine> = {
    emitState(next) {
      getOpenPhase(`emitState(${next.kind})`);
      setState(next);
    },
    emitSideEffect(effect) {
      getOpenPhase('emitSideEffect').effects.push(effect);
    },
    update,
  };

  return {
    emits,
    /** Ends the transition and returns its effects in the order they were emitted. */
    end() {
      const { effects } = getOpenPhase('end');
      phase = { kind: 'ended' };
      return effects;
    },
  };

  function getOpenPhase(action: string) {
    switch (phase.kind) {
      case 'open':
        return phase;
      case 'ended':
        throw new Error(`createStateMachine: ${action} was called after its transition ended`);
    }
  }
}
