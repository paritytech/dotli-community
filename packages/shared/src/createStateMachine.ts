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
   * ended. Never throws while `onError` keeps its contract.
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
  ) => void;
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

/** A lifecycle nested in a machine's state. Its events and effects are some of the machine's. */
type NestedOf<Machine extends AnyMachine> = {
  state: { kind: string };
  event: Machine['event'];
  effect: Machine['effect'];
};

type Handler<Machine extends AnyMachine> = (
  state: Machine['state'],
  event: Machine['event'],
  transition: Transition<Machine>,
) => void;

type Params<Machine extends AnyMachine> = {
  initial: Machine['state'];
  handlers: StateHandlers<Machine>;
  /**
   * Hears a handler or an effect that threw, and an update whose work rejected. MUST NOT throw. The feature wires its
   * reporter here.
   */
  onError: (error: unknown) => void;
} & ([Machine['effect']] extends [never]
  ? { onEffect?: never }
  : {
      /** Runs each effect after the transition that emitted it. A throw goes to `onError`. */
      onEffect: (effect: Machine['effect']) => void;
    });

type NestParams<
  Machine extends AnyMachine,
  Kind extends Machine['state']['kind'],
  Nested extends NestedOf<Machine>,
  Routed extends Nested['event'],
> = {
  /** The nested state `event` is for, or `null` when there is none, such as a key that left. Must not throw. */
  find: (state: Extract<Machine['state'], { kind: Kind }>, event: Routed) => Nested['state'] | null;
  /** `state` with the nested state `event` is for replaced by `next`, or dropped when `next` is one that leaves. Must not throw. */
  store: (
    state: Extract<Machine['state'], { kind: Kind }>,
    event: Routed,
    next: Nested['state'],
  ) => Extract<Machine['state'], { kind: Kind }>;
  handlers: StateHandlers<Nested>;
};

/**
 * One state that moves only through transitions, each run by the handler of the state it starts in.
 *
 * A handler moves the state at once with `emitState` and queues side effects with `emitSideEffect`. Once the handler
 * returns, its transition ends and `onEffect` runs the effects in the order they were emitted. An effect that throws
 * goes to `onError`, and the next effect still runs. A handler's throw goes to `onError` after its effects. An event
 * its state has no handler for is ignored.
 *
 * A handler returns nothing and sends async work as `update(promise)`. Transitions never overlap. An event sent from
 * inside a transition or an effect runs right after that transition and its effects, before the outer `update`
 * returns, so the state always moves inside `update`.
 *
 * A lifecycle nested in a state, such as one entry of a keyed set or an independent sub-phase, runs inside the same
 * machine through `nest`.
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
  // Each update whose work is a promise, until its event is handled. An event alone is handled before `update` returns,
  // so this pool is idle only when the machine has nothing pending.
  const updates = createAsyncTaskPool({ poolSize: Number.POSITIVE_INFINITY });
  // Events sent while a transition runs wait here, so transitions never overlap and an event sent from inside one
  // still runs before the outer `update` returns.
  let drain: { kind: 'idle' } | { kind: 'draining'; queued: Machine['event'][] } = { kind: 'idle' };

  return {
    /** The current state. A handler's `emitState` moves it. */
    state,
    /**
     * Handles the event now, or right after the transition that sent it. Work that is a promise is handled once it
     * resolves, and work that rejects goes to `onError`. Never throws while `onError` keeps its contract.
     */
    update,
    /** Resolves once no update waits on its work. Resolves at once when none does. Never rejects. */
    await(): Promise<void> {
      return updates.settle();
    },
  };

  function update(event: Update<Machine>): void {
    if (event instanceof Promise) {
      void updates.call(() => event.then(transit)).catch(onError);
      return;
    }
    transit(event);
  }

  function transit(event: Machine['event']): void {
    if (drain.kind === 'draining') {
      drain.queued.push(event);
      return;
    }
    const queued = [event];
    drain = { kind: 'draining', queued };
    try {
      let next = queued.shift();
      while (next !== undefined) {
        runTransition(next);
        next = queued.shift();
      }
    } finally {
      drain = { kind: 'idle' };
    }
  }

  /**
   * Runs the handler for `event` in the current state, then its effects. Never throws while `onError` keeps its
   * contract.
   */
  function runTransition(event: Machine['event']): void {
    const from = current.get();
    const handle = getHandler(handlers, from, event);
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
      handle(from, event, transition.emits);
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
}

/**
 * A handler that runs a lifecycle nested in the states of `Kind`, such as one entry of a keyed set or an independent
 * sub-phase, through its own handler table. `find` reads the nested state the event is for, and `store` writes the
 * state the nested handler emits back into the parent's, or drops it. The nested handlers get the machine's own
 * `update` and `emitSideEffect`.
 *
 * `EventKind` names the events this handler routes, and defaults to every event kind of the nested machine. Name them
 * when the nested machine has events that the parent sends to it by another handler.
 *
 * @example
 * // A table of waits keyed by id, each one its own small lifecycle.
 * const handleWait = nest<RepliesMachine, 'open', WaitMachine, 'replied' | 'failed'>({
 *   find: ({ waits }, { id }) => waits.get(id) ?? null,
 *   store: (state, { id }, next) => ({ ...state, waits: withWait(state.waits, id, next) }),
 *   handlers: { waiting: { replied: settleWait, failed: settleWait }, settled: null },
 * });
 * // The table row of the parent: { open: { replied: handleWait, failed: handleWait } }
 */
export function nest<
  Machine extends AnyMachine,
  Kind extends Machine['state']['kind'],
  Nested extends NestedOf<Machine>,
  EventKind extends Nested['event']['kind'] = Nested['event']['kind'],
>({
  find,
  store,
  handlers,
}: NestParams<Machine, Kind, Nested, Extract<Nested['event'], { kind: EventKind }>>): (
  state: Extract<Machine['state'], { kind: Kind }>,
  event: Extract<Nested['event'], { kind: EventKind }>,
  transition: Transition<Machine>,
) => void {
  return (state, event, transition) => {
    const nested = find(state, event);
    if (nested === null) {
      return;
    }
    const handle = getHandler(handlers, nested, event);
    if (handle === null) {
      return;
    }
    // A second emit in one transition stores into the state the first one left, not the one it started in.
    let latest = state;
    handle(nested, event, {
      emitState(next) {
        latest = store(latest, event, next);
        transition.emitState(latest);
      },
      emitSideEffect: transition.emitSideEffect,
      update: transition.update,
    });
  };
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

function getHandler<Machine extends AnyMachine>(
  handlers: StateHandlers<Machine>,
  from: Machine['state'],
  event: Machine['event'],
): Handler<Machine> | null {
  // A generic `kind` reads as a plain string, and so the table cannot narrow each handler's parameters to the kinds it
  // is keyed by. The machine only calls a handler with the state and the event of its own keys.
  const byEvent = handlers[from.kind as Machine['state']['kind']] as Partial<Record<string, Handler<Machine>>> | null;
  return byEvent?.[event.kind] ?? null;
}
