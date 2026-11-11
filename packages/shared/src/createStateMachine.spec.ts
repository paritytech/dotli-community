// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createDeferred } from './createDeferred.js';
import { createStateMachine, type HandlersOf, type MachineTypes, type Transition } from './createStateMachine.js';
import { getErrorMessage } from './getErrorMessage.js';
import { noop } from './noop.js';
import { catchError } from './testing/catchError.js';
import { must } from './testing/must.js';

type TestState = { kind: 'idle' } | { kind: 'busy'; step: number };

type TestEvent = { kind: 'named'; name: string } | { kind: 'unhandled' };

type TestEffect = { kind: 'noted'; note: string };

type TestMachine = MachineTypes<TestState, TestEvent, TestEffect>;

type PlainMachine = MachineTypes<TestState, TestEvent>;

type Handle<Machine extends PlainMachine | TestMachine = PlainMachine> = (
  state: TestState,
  event: Extract<TestEvent, { kind: 'named' }>,
  transition: Transition<Machine>,
) => Promise<void> | void;

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

  it('As a unit, I send an event while a transition awaits and it runs after that transition', async () => {
    // Given a first transition that awaits a deferred and then logs its end
    const log: string[] = [];
    const release = createDeferred<undefined>();
    const secondHandled = createDeferred<undefined>();
    const { machine } = createTestMachine({
      handle: async (_state, { name }) => {
        log.push(`handle:${name}`);
        if (name === 'first') {
          await release.promise;
          log.push('end:first');
          return;
        }
        secondHandled.resolve(undefined);
      },
    });
    machine.update(named('first'));

    // When a second event is sent, and then the first transition's wait ends
    machine.update(named('second'));
    release.resolve(undefined);
    await secondHandled.promise;

    // Then
    expect(log).toEqual(['handle:first', 'end:first', 'handle:second']);
  });

  it('As a handler, I send an event from my own transition and it runs after my transition ends', async () => {
    // Given a handler that sends an event and then logs its end
    const log: string[] = [];
    const fromHandlerHandled = createDeferred<undefined>();
    const { machine } = createTestMachine({
      handle: (_state, { name }, { update }) => {
        log.push(`handle:${name}`);
        if (name === 'start') {
          update(named('fromHandler'));
          log.push('end:start');
          return;
        }
        fromHandlerHandled.resolve(undefined);
      },
    });

    // When
    machine.update(named('start'));
    await fromHandlerHandled.promise;

    // Then
    expect(log).toEqual(['handle:start', 'end:start', 'handle:fromHandler']);
  });

  it('As a caller, I await an idle machine and it resolves at once', async () => {
    // Given a machine with no transition queued or running
    const { machine } = createTestMachine({ handle: noop });

    // When
    const settled = machine.await();

    // Then
    await expect(settled).resolves.toBeUndefined();
  });

  it('As a caller, I await the machine and it resolves once the transitions its handlers queued are done', async () => {
    // Given a first transition that awaits a deferred and then sends a second event
    const log: string[] = [];
    const release = createDeferred<undefined>();
    const { machine } = createTestMachine({
      handle: async (_state, { name }, { update }) => {
        if (name === 'first') {
          await release.promise;
          update(named('second'));
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

  it.each<{ how: string; fail: (error: Error) => Promise<void> | undefined }>([
    {
      how: 'synchronous throw',
      fail: error => {
        throw error;
      },
    },
    {
      how: 'rejection after an await',
      fail: async error => {
        await Promise.resolve();
        throw error;
      },
    },
  ])(
    'As a unit whose handler emits and then fails by a $how, I keep what it emitted and onError hears the error last',
    async ({ fail }) => {
      // Given a handler that emits a state and an effect before it fails, and handles the next event
      const nextHandled = createDeferred<undefined>();
      const { machine, log } = createEffectMachine({
        handle: (_state, { name }, transition) => {
          if (name === 'fail') {
            transition.emitState({ kind: 'busy', step: 1 });
            transition.emitSideEffect(noted('kept'));
            return fail(new Error('handler broke'));
          }
          nextHandled.resolve(undefined);
          return undefined;
        },
      });

      // When
      machine.update(named('fail'));
      machine.update(named('next'));
      await nextHandled.promise;

      // Then
      expect([machine.state.get(), log]).toEqual([{ kind: 'busy', step: 1 }, ['effect:kept', 'error:handler broke']]);
    },
  );

  it("As an effect runner, I send an event and it runs after the rest of the transition's effects", async () => {
    // Given a handler that emits effects a and b on start, and a runner that sends an event on a
    const fromEffectHandled = createDeferred<undefined>();
    const { machine, log } = createEffectMachine({
      handle: (_state, { name }, transition) => {
        if (name === 'start') {
          transition.emitSideEffect(noted('a'));
          transition.emitSideEffect(noted('b'));
          return;
        }
        log.push(`handle:${name}`);
        fromEffectHandled.resolve(undefined);
      },
      runEffect: ({ note }) => {
        if (note === 'a') {
          machine.update(named('fromEffect'));
        }
      },
    });

    // When
    machine.update(named('start'));
    await fromEffectHandled.promise;

    // Then
    expect(log).toEqual(['effect:a', 'effect:b', 'handle:fromEffect']);
  });

  it('As a unit, I type one group for two states with HandlersOf and it handles the event in each', async () => {
    // Given one group in the slots of both states, which moves idle to busy
    const handled: string[] = [];
    const secondHandled = createDeferred<undefined>();
    const shared: HandlersOf<TestMachine, 'idle' | 'busy'> = {
      named(state, { name }, { emitState }) {
        handled.push(`${state.kind}:${name}`);
        emitState({ kind: 'busy', step: handled.length });
        if (name === 'second') {
          secondHandled.resolve(undefined);
        }
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
    await secondHandled.promise;

    // Then
    expect(handled).toEqual(['idle:first', 'busy:second']);
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

function named(name: string): TestEvent {
  return { kind: 'named', name };
}

function noted(note: string): TestEffect {
  return { kind: 'noted', note };
}
