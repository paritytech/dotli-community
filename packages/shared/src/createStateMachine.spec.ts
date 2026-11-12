// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createDeferred } from './createDeferred.js';
import {
  createStateMachine,
  nest,
  type HandlersOf,
  type MachineTypes,
  type StateHandlers,
  type Transition,
} from './createStateMachine.js';
import { getErrorMessage } from './getErrorMessage.js';
import { noop } from './noop.js';
import { catchError } from './testing/catchError.js';
import { must } from './testing/must.js';

type TestState = { kind: 'idle' } | { kind: 'busy'; step: number };

type TestEvent = { kind: 'named'; name: string } | { kind: 'unhandled' };

type TestEffect = { kind: 'noted'; note: string };

type TestMachine = MachineTypes<TestState, TestEvent, TestEffect>;

type PlainMachine = MachineTypes<TestState, TestEvent>;

type Watch = { kind: 'off' } | { kind: 'on'; token: string };

type Entry = { kind: 'waiting'; watch: Watch } | { kind: 'done' };

type KeyedState = { kind: 'open'; entries: ReadonlyMap<string, Entry> };

type KeyedEvent =
  | { kind: 'finished'; key: string }
  | { kind: 'watched'; key: string; token: string }
  | { kind: 'broke'; key: string }
  | { kind: 'told'; note: string };

type KeyedMachine = MachineTypes<KeyedState, KeyedEvent>;

type EntryMachine = MachineTypes<Entry, KeyedEvent>;

type WatchMachine = MachineTypes<Watch, Extract<KeyedEvent, { kind: 'watched' }>>;

type Handle<Machine extends PlainMachine | TestMachine = PlainMachine> = (
  state: TestState,
  event: Extract<TestEvent, { kind: 'named' }>,
  transition: Transition<Machine>,
) => void;

describe('createStateMachine', () => {
  it('As a unit, I send an event to a new machine and my state moves before update returns', () => {
    // Given a machine whose handler emits a state without awaiting
    const { machine } = createTestMachine({
      handle: (_state, _event, transition) => {
        transition.emitState({ kind: 'busy', step: 1 });
      },
    });

    // When
    machine.update(named('start'));

    // Then
    expect(machine.state.get()).toEqual({ kind: 'busy', step: 1 });
  });

  it('As a unit, I send an event my state has no handler for and nothing moves', () => {
    // Given a machine whose states handle only named events
    const { machine, errors } = createTestMachine({
      handle: (_state, _event, transition) => {
        transition.emitState({ kind: 'busy', step: 1 });
      },
    });

    // When
    machine.update({ kind: 'unhandled' });

    // Then
    expect([machine.state.get(), errors]).toEqual([{ kind: 'idle' }, []]);
  });

  it('As a unit in a state that handles no event, I send an event and nothing moves', () => {
    // Given a machine whose states have no handlers
    const errors: unknown[] = [];
    const machine = createStateMachine<PlainMachine>({
      initial: { kind: 'idle' },
      handlers: { idle: null, busy: null },
      onError: error => {
        errors.push(error);
      },
    });

    // When
    machine.update(named('start'));

    // Then
    expect([machine.state.get(), errors]).toEqual([{ kind: 'idle' }, []]);
  });

  it('As a unit, I send two events one after the other and my state reads the second before update returns', () => {
    // Given a handler that emits a busy state whose step is the event's name
    const { machine } = createTestMachine({
      handle: (_state, { name }, transition) => {
        transition.emitState({ kind: 'busy', step: Number(name) });
      },
    });

    // When
    machine.update(named('1'));
    machine.update(named('2'));

    // Then
    expect(machine.state.get()).toEqual({ kind: 'busy', step: 2 });
  });

  it('As a handler, I send an event from my own transition and it runs after my transition ends', () => {
    // Given a handler that sends an event and then logs its end
    const log: string[] = [];
    const { machine } = createTestMachine({
      handle: (_state, { name }, { update }) => {
        log.push(`handle:${name}`);
        if (name === 'start') {
          update(named('fromHandler'));
          log.push('end:start');
        }
      },
    });

    // When
    machine.update(named('start'));

    // Then
    expect(log).toEqual(['handle:start', 'end:start', 'handle:fromHandler']);
  });

  it('As a handler, I send two events and then throw, and both run in order before update returns', () => {
    // Given a handler that, for a, sends b and c and then throws
    const { machine, log } = createEffectMachine({
      handle: (_state, { name }, { update }) => {
        log.push(`handle:${name}`);
        if (name === 'a') {
          update(named('b'));
          update(named('c'));
          throw new Error('a broke');
        }
      },
    });

    // When
    machine.update(named('a'));

    // Then
    expect(log).toEqual(['handle:a', 'error:a broke', 'handle:b', 'handle:c']);
  });

  it('As a caller, I await an idle machine and it resolves at once', async () => {
    // Given a machine with no transition queued or running
    const { machine } = createTestMachine({ handle: noop });

    // When
    const settled = machine.await();

    // Then
    await expect(settled).resolves.toBeUndefined();
  });

  it('As a caller, I await the machine and it resolves once the work its handlers sent is handled', async () => {
    // Given a first transition that sends work which resolves to a second event once released
    const log: string[] = [];
    const release = createDeferred<undefined>();
    const { machine } = createTestMachine({
      handle: (_state, { name }, { update }) => {
        if (name === 'first') {
          update(release.promise.then(() => named('second')));
        }
        log.push(`handled:${name}`);
      },
    });
    machine.update(named('first'));
    const settled = machine.await().then(() => {
      log.push('settled');
    });

    // When
    release.resolve(undefined);
    await settled;

    // Then
    expect(log).toEqual(['handled:first', 'handled:second', 'settled']);
  });

  it('As a caller, I await the machine and it waits for an update whose work is still on its way', async () => {
    // Given an update whose event comes from work that has not resolved yet
    const log: string[] = [];
    const work = createDeferred<TestEvent>();
    const { machine } = createTestMachine({
      handle: (_state, { name }) => {
        log.push(`handled:${name}`);
      },
    });
    machine.update(work.promise);
    const settled = machine.await().then(() => {
      log.push('settled');
    });

    // When
    work.resolve(named('landed'));
    await settled;

    // Then
    expect(log).toEqual(['handled:landed', 'settled']);
  });

  it('As a unit, I update with work that rejects and onError hears it while my state stays', async () => {
    // Given
    const broken = new Error('read broke');
    const { machine, errors } = createTestMachine({ handle: noop });

    // When
    machine.update(Promise.reject(broken));
    await machine.await();

    // Then
    expect([machine.state.get(), errors]).toEqual([{ kind: 'idle' }, [broken]]);
  });

  it('As a handler that keeps its transition past its end, I am refused when I emitState later', () => {
    // Given a transition that emitted a state, kept by its handler after it ended
    let kept: Transition<PlainMachine> | undefined;
    const { machine } = createTestMachine({
      handle: (_state, _event, transition) => {
        kept = transition;
        transition.emitState({ kind: 'busy', step: 1 });
      },
    });
    machine.update(named('start'));

    // When
    const failure = catchError(() => {
      must(kept, 'the kept transition').emitState({ kind: 'busy', step: 2 });
    });

    // Then
    expect([failure instanceof Error, machine.state.get()]).toEqual([true, { kind: 'busy', step: 1 }]);
  });

  it('As a handler that keeps its transition past its end, I am refused when I emitSideEffect later', () => {
    // Given a transition that emitted an effect, kept by its handler after it ended
    let kept: Transition<TestMachine> | undefined;
    const { machine, log } = createEffectMachine({
      handle: (_state, _event, transition) => {
        kept = transition;
        transition.emitSideEffect(noted('kept'));
      },
    });
    machine.update(named('start'));

    // When
    const failure = catchError(() => {
      must(kept, 'the kept transition').emitSideEffect(noted('late'));
    });

    // Then
    expect([failure instanceof Error, log]).toEqual([true, ['effect:kept']]);
  });

  it('As a handler, I emit side effects and they run after my transition, in the order I emitted them', () => {
    // Given a handler that emits an effect, sets a state, then emits another effect
    const heard: { note: string; state: TestState['kind'] }[] = [];
    const { machine } = createEffectMachine({
      handle: (_state, _event, transition) => {
        transition.emitSideEffect(noted('a'));
        transition.emitState({ kind: 'busy', step: 1 });
        transition.emitSideEffect(noted('b'));
      },
      runEffect: ({ note }) => {
        heard.push({ note, state: machine.state.get().kind });
      },
    });

    // When
    machine.update(named('start'));

    // Then
    expect(heard).toEqual([
      { note: 'a', state: 'busy' },
      { note: 'b', state: 'busy' },
    ]);
  });

  it('As a unit whose effect runner throws, onError hears it and the next effect still runs', () => {
    // Given a handler that emits effects a and b, and a runner that throws on a
    const { machine, log } = createEffectMachine({
      handle: (_state, _event, transition) => {
        transition.emitSideEffect(noted('a'));
        transition.emitSideEffect(noted('b'));
      },
      runEffect: ({ note }) => {
        if (note === 'a') {
          throw new Error('effect broke');
        }
      },
    });

    // When
    machine.update(named('start'));

    // Then
    expect(log).toEqual(['effect:a', 'error:effect broke', 'effect:b']);
  });

  it('As a unit whose handler emits and then throws, I keep what it emitted and onError hears the error last', () => {
    // Given a handler that emits a state and an effect before it throws, and handles the next event
    const { machine, log } = createEffectMachine({
      handle: (_state, { name }, transition) => {
        if (name === 'fail') {
          transition.emitState({ kind: 'busy', step: 1 });
          transition.emitSideEffect(noted('kept'));
          throw new Error('handler broke');
        }
      },
    });

    // When
    machine.update(named('fail'));
    machine.update(named('next'));

    // Then
    expect([machine.state.get(), log]).toEqual([{ kind: 'busy', step: 1 }, ['effect:kept', 'error:handler broke']]);
  });

  it("As an effect runner, I send an event and it runs after the rest of the transition's effects", () => {
    // Given a handler that emits effects a and b on start, and a runner that sends an event on a
    const { machine, log } = createEffectMachine({
      handle: (_state, { name }, transition) => {
        if (name === 'start') {
          transition.emitSideEffect(noted('a'));
          transition.emitSideEffect(noted('b'));
          return;
        }
        log.push(`handle:${name}`);
      },
      runEffect: ({ note }) => {
        if (note === 'a') {
          machine.update(named('fromEffect'));
        }
      },
    });

    // When
    machine.update(named('start'));

    // Then
    expect(log).toEqual(['effect:a', 'effect:b', 'handle:fromEffect']);
  });

  it('As a unit, I type one group for two states with HandlersOf and it handles the event in each', () => {
    // Given one group in the slots of both states, which moves idle to busy
    const handled: string[] = [];
    const shared: HandlersOf<TestMachine, 'idle' | 'busy'> = {
      named(state, { name }, { emitState }) {
        handled.push(`${state.kind}:${name}`);
        emitState({ kind: 'busy', step: handled.length });
      },
    };
    // and a machine the types refuse: a busy group in the idle slot, and a group that reads a step an idle state lacks
    const busyOnly: HandlersOf<TestMachine, 'busy'> = { named: noop };
    const readsStep: HandlersOf<TestMachine, 'idle' | 'busy'> = {
      named(state) {
        // @ts-expect-error an idle state has no step
        handled.push(String(state.step));
      },
    };
    createStateMachine<TestMachine>({
      initial: { kind: 'idle' },
      // @ts-expect-error a group for the busy state does not fill the idle slot
      handlers: { idle: busyOnly, busy: readsStep },
      onEffect: noop,
      onError: noop,
    });
    const machine = createStateMachine<TestMachine>({
      initial: { kind: 'idle' },
      handlers: { idle: shared, busy: shared },
      onEffect: noop,
      onError: noop,
    });

    // When
    machine.update(named('first'));
    machine.update(named('second'));

    // Then
    expect(handled).toEqual(['idle:first', 'busy:second']);
  });
});

describe('nest', () => {
  it('As a keyed table, I settle an entry and it leaves, while a later event for its key moves nothing', () => {
    // Given a table whose entry a settled
    const { machine } = createKeyedMachine();
    machine.update({ kind: 'finished', key: 'a' });
    const settled = machine.state.get();

    // When
    machine.update({ kind: 'finished', key: 'a' });

    // Then
    expect(settled.entries.has('a')).toBe(false);
    expect(machine.state.get()).toBe(settled);
  });

  it("As a nested handler, I send an event and the machine's own handler hears it after my transition", () => {
    // Given a table whose entries send told once they finish
    const { machine, log, handleEntry } = createKeyedMachine();
    // and a table the types refuse, with the entry nest under told, an event it does not route
    createStateMachine<KeyedMachine>({
      initial: machine.state.get(),
      // @ts-expect-error the entry nest does not fill the told slot
      handlers: { open: { told: handleEntry } },
      onError: noop,
    });

    // When
    machine.update({ kind: 'finished', key: 'a' });

    // Then told lists the entries left after a's transition stored it as gone
    expect(log).toEqual(['told:a done:b']);
  });

  it('As a nested handler, I throw and onError hears it while the table keeps its entries', () => {
    // Given a table whose entries throw when they break
    const { machine, log } = createKeyedMachine();
    const before = machine.state.get();

    // When
    machine.update({ kind: 'broke', key: 'a' });

    // Then
    expect(log).toEqual(['error:entry broke']);
    expect(machine.state.get()).toBe(before);
  });

  it('As a keyed entry with a sub-phase, I move the sub-phase and the entry and its neighbours keep the rest', () => {
    // Given a table whose entries watch once, through a sub-phase whose on state handles nothing
    const { machine } = createKeyedMachine();
    const before = machine.state.get();

    // When a is watched twice
    machine.update({ kind: 'watched', key: 'a', token: 't1' });
    const watched = machine.state.get();
    machine.update({ kind: 'watched', key: 'a', token: 't2' });

    // Then
    expect(watched.entries.get('a')).toEqual({ kind: 'waiting', watch: { kind: 'on', token: 't1' } });
    expect(watched.entries.get('b')).toBe(before.entries.get('b'));
    expect(machine.state.get()).toBe(watched);
  });
});

type CreateTestMachineParams = {
  handle: Handle;
};

/** A machine whose every state handles named events with `handle`, and which records what `onError` hears. */
function createTestMachine({ handle }: CreateTestMachineParams) {
  const errors: unknown[] = [];
  const machine = createStateMachine<PlainMachine>({
    initial: { kind: 'idle' },
    handlers: { idle: { named: handle }, busy: { named: handle } },
    onError: error => {
      errors.push(error);
    },
  });

  return { machine, errors };
}

type CreateEffectMachineParams = {
  handle: Handle<TestMachine>;
  /** Runs each effect once the log has it. */
  runEffect?: (effect: TestEffect) => void;
};

/**
 * A machine whose every state handles named events with `handle`, and which logs each effect as `effect:<note>` and
 * each error `onError` hears as `error:<message>`, in the order they come.
 */
function createEffectMachine({ handle, runEffect = noop }: CreateEffectMachineParams) {
  const log: string[] = [];
  const machine = createStateMachine<TestMachine>({
    initial: { kind: 'idle' },
    handlers: { idle: { named: handle }, busy: { named: handle } },
    onEffect: effect => {
      log.push(`effect:${effect.note}`);
      runEffect(effect);
    },
    onError: error => {
      log.push(`error:${getErrorMessage(error)}`);
    },
  });

  return { machine, log };
}

/**
 * A table of entries a and b run through `nest`, each with a watch sub-phase run through a `nest` of its own. It logs
 * each `told` as `told:<note>:<keys left>` and each error `onError` hears as `error:<message>`.
 */
function createKeyedMachine() {
  const log: string[] = [];
  const watchHandlers: StateHandlers<WatchMachine> = {
    off: {
      watched(_watch, { token }, { emitState }) {
        emitState({ kind: 'on', token });
      },
    },
    on: null,
  };
  const entryHandlers: StateHandlers<EntryMachine> = {
    waiting: {
      finished(_entry, { key }, { emitState, update }) {
        emitState({ kind: 'done' });
        update({ kind: 'told', note: `${key} done` });
      },
      broke() {
        throw new Error('entry broke');
      },
      watched: nest<EntryMachine, 'waiting', WatchMachine>({
        find: entry => entry.watch,
        store: (entry, _event, watch) => ({ ...entry, watch }),
        handlers: watchHandlers,
      }),
    },
    done: null,
  };
  const handleEntry = nest<KeyedMachine, 'open', EntryMachine, 'finished' | 'watched' | 'broke'>({
    find: ({ entries }, { key }) => entries.get(key) ?? null,
    store(state, { key }, next) {
      const entries = new Map(state.entries);
      if (next.kind === 'done') {
        entries.delete(key);
      } else {
        entries.set(key, next);
      }
      return { ...state, entries };
    },
    handlers: entryHandlers,
  });
  const machine = createStateMachine<KeyedMachine>({
    initial: {
      kind: 'open',
      entries: new Map<string, Entry>([
        ['a', { kind: 'waiting', watch: { kind: 'off' } }],
        ['b', { kind: 'waiting', watch: { kind: 'off' } }],
      ]),
    },
    handlers: {
      open: {
        finished: handleEntry,
        watched: handleEntry,
        broke: handleEntry,
        told({ entries }, { note }) {
          log.push(`told:${note}:${[...entries.keys()].join(',')}`);
        },
      },
    },
    onError: error => {
      log.push(`error:${getErrorMessage(error)}`);
    },
  });

  return { machine, log, handleEntry };
}

function named(name: string): TestEvent {
  return { kind: 'named', name };
}

function noted(note: string): TestEffect {
  return { kind: 'noted', note };
}
