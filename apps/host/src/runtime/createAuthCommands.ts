// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's login, logout and cancel over one queue, so overlapping calls never reach the core twice. A login answers
// every call made in its round, and a logout runs its end in the order it was asked for.

import { createReporter, defineCount } from '@dotli/metrics';
import { createAsyncTaskPool, createDeferred, createStateMachine, type MachineTypes } from '@dotli/shared';
import type { ReadableAtom } from 'nanostores';
import { authViews } from './session/authViews.js';
import type { DotliAuthState } from './session/types.js';
import type { TruapiSessionUiState } from './session/parseUiStateCache.js';

/**
 * How a login ended. `paired` once the core reports the account signed in and, for a pairing, the page's copy holds the
 * session it stored. `failed` was reported where it happened, `cancelled` is a round ended by a cancel or a logout.
 */
export type LoginOutcome =
  { kind: 'paired'; account: TruapiSessionUiState } | { kind: 'failed' } | { kind: 'cancelled' };

/** Why a login was asked for. */
export type LoginParams = {
  /** Why the sign-in was asked for, which the modal shows. */
  reason?: string | undefined;
};

/** One login on the core: why it was asked for, and the signal of its round. */
export type CoreLoginParams = LoginParams & {
  /** Aborts once a cancel or a logout ends the round, so a login still waiting for its core sends nothing. */
  signal: AbortSignal;
};

type Params = {
  /** The page's auth state, which tells a login of a user already signed in. */
  auth: ReadableAtom<DotliAuthState>;
  /**
   * One login to its end, answering how it ended and reporting its own failures. Rejects when the core paired but its
   * session could not be stored or read back.
   */
  login: (params: CoreLoginParams) => Promise<LoginOutcome>;
  /** Stops the pairing under way on the core. Never throws. */
  cancelPairing: () => void;
};

/** A call to `login`, which its round's login answers. */
type LoginWaiter = ReturnType<typeof createDeferred<LoginOutcome>>;

/** The calls of one login, which share how it ended. The first call is the one whose login runs. */
type LoginRound = { id: symbol; controller: AbortController; waiters: readonly [LoginWaiter, ...LoginWaiter[]] };

/**
 * The login rounds whose login has not ended. A round ends when its login ends or when a cancel or logout is asked
 * for, whichever comes first, so a click after either still logs in. `current` is the round a click joins, which a
 * cancel or logout clears, while the round stays until its login ends and answers its calls.
 */
type CommandsState = { kind: 'open'; current: symbol | null; rounds: ReadonlyMap<symbol, LoginRound> };

type CommandsEvent =
  | { kind: 'loginAsked'; reason: LoginParams['reason']; waiter: LoginWaiter }
  | { kind: 'roundEnded'; by: 'cancel' | 'logout' }
  | { kind: 'roundAnswered'; id: symbol; outcome: LoginOutcome }
  | { kind: 'roundFailed'; id: symbol; error: unknown };

type CommandsEffect =
  | { kind: 'queueLogin'; id: symbol; reason: LoginParams['reason']; signal: AbortSignal }
  | { kind: 'abortLogin'; controller: AbortController }
  | { kind: 'cancelPairing' }
  | { kind: 'cancelRunningPairing' }
  | { kind: 'resolve'; waiters: readonly LoginWaiter[]; outcome: LoginOutcome }
  | { kind: 'reject'; waiters: readonly LoginWaiter[]; error: unknown };

type CommandsMachine = MachineTypes<CommandsState, CommandsEvent, CommandsEffect>;

/** The answer of a login that a cancel or a logout ended. */
export const CANCELLED: LoginOutcome = { kind: 'cancelled' };
/** The answer of a login whose failure was reported where it happened. */
export const FAILED: LoginOutcome = { kind: 'failed' };

const authReport = createReporter({ flow: 'wallet' });

/** A login round's transition that threw. Tagged `outcome` (error). */
const authCommandsTransitionMetric = defineCount<'error'>('auth_commands.transition');

/** Returns the page's login, logout and cancel over one queue. Never throws. */
export function createAuthCommands({ auth, login, cancelPairing }: Params) {
  const queue = createAsyncTaskPool({ poolSize: 1 });
  const machine = createStateMachine<CommandsMachine>({
    initial: { kind: 'open', current: null, rounds: new Map() },
    handlers: {
      open: {
        loginAsked(state, { reason, waiter }, { emitState, emitSideEffect }) {
          const joined = getCurrentRound(state);
          if (joined !== undefined) {
            // A click while a round runs shares its login, so it starts no second pairing.
            const round: LoginRound = { ...joined, waiters: [...joined.waiters, waiter] };
            emitState({ ...state, rounds: new Map(state.rounds).set(round.id, round) });
            return;
          }
          const round: LoginRound = { id: Symbol('login round'), controller: new AbortController(), waiters: [waiter] };
          emitState({ ...state, current: round.id, rounds: new Map(state.rounds).set(round.id, round) });
          emitSideEffect({ kind: 'queueLogin', id: round.id, reason, signal: round.controller.signal });
        },
        // Ends the round a click would join, so a login still waiting for its core hears the abort and sends nothing.
        roundEnded(state, { by }, { emitState, emitSideEffect }) {
          const ended = getCurrentRound(state);
          if (ended !== undefined) {
            emitState({ ...state, current: null });
            emitSideEffect({ kind: 'abortLogin', controller: ended.controller });
          }
          // A logout queues behind the open login, which only the cancel ends when the core never answers it.
          emitSideEffect({ kind: by === 'cancel' ? 'cancelPairing' : 'cancelRunningPairing' });
        },
        roundAnswered(state, { id, outcome }, { emitState, emitSideEffect }) {
          const round = state.rounds.get(id);
          if (round === undefined) {
            return;
          }
          emitState(withoutRound(state, id));
          emitSideEffect({ kind: 'resolve', waiters: round.waiters, outcome });
        },
        roundFailed(state, { id, error }, { emitState, emitSideEffect }) {
          const round = state.rounds.get(id);
          if (round === undefined) {
            return;
          }
          const [first, ...queued] = round.waiters;
          emitState(withoutRound(state, id));
          emitSideEffect({ kind: 'reject', waiters: [first], error });
          if (state.current === id) {
            emitSideEffect({
              kind: 'reject',
              waiters: queued,
              error: new Error('The login this call queued behind failed', { cause: error }),
            });
            return;
          }
          // A cancel or logout ended the round before its login failed.
          emitSideEffect({ kind: 'resolve', waiters: queued, outcome: CANCELLED });
        },
      },
    },
    onEffect(effect) {
      switch (effect.kind) {
        case 'queueLogin': {
          const { id, reason, signal } = effect;
          machine.update(
            queue
              .call(async (): Promise<LoginOutcome> => {
                // A round a cancel or logout ended while it queued sends nothing to the core.
                if (signal.aborted) {
                  return CANCELLED;
                }
                const account = authViews.getSignedInSession(auth.get());
                if (account !== null) {
                  return { kind: 'paired', account };
                }
                return login({ reason, signal });
              })
              .then(
                outcome => ({ kind: 'roundAnswered', id, outcome }),
                (error: unknown) => ({ kind: 'roundFailed', id, error }),
              ),
          );
          return;
        }
        case 'abortLogin':
          effect.controller.abort(new DOMException('The sign-in was cancelled', 'AbortError'));
          return;
        case 'cancelPairing':
          cancelPairing();
          return;
        case 'cancelRunningPairing':
          if (authViews.isLoginRunning(auth.get())) {
            cancelPairing();
          }
          return;
        case 'resolve':
          for (const waiter of effect.waiters) {
            waiter.resolve(effect.outcome);
          }
          return;
        case 'reject':
          for (const waiter of effect.waiters) {
            waiter.reject(effect.error);
          }
          return;
      }
    },
    onError(error) {
      authReport.defect(error, {
        step: 'transition',
        metric: authCommandsTransitionMetric,
        message: '[dot.li auth] A login round transition threw',
      });
    },
  });

  return {
    /**
     * Answers how the login ended. A click queued behind a login shares its answer. Answers `paired` at once for a user
     * already signed in. Rejects when the core paired but its session could not be stored or read back. A call queued
     * behind a login that rejects rejects too, with that failure as its cause.
     */
    login({ reason }: LoginParams = {}): Promise<LoginOutcome> {
      const waiter = createDeferred<LoginOutcome>();
      machine.update({ kind: 'loginAsked', reason, waiter });
      return waiter.promise;
    },
    /**
     * Ends the login round and cancels a pairing under way, since the core may never answer it, then runs `end` once no
     * login is open, in the order logins and logouts were asked for, and answers what it answers. What there is to end
     * is `end`'s to decide. Rejects when `end` rejects.
     */
    logout<T>(end: () => Promise<T>): Promise<T> {
      machine.update({ kind: 'roundEnded', by: 'logout' });
      return queue.call(end);
    },
    /**
     * Stops the pairing under way, at once and outside the queue, and ends the login round, so a later click logs in.
     * Never throws.
     */
    cancelLogin(): void {
      machine.update({ kind: 'roundEnded', by: 'cancel' });
    },
  };
}

/** The round a click joins, if one is open. */
function getCurrentRound({ current, rounds }: CommandsState): LoginRound | undefined {
  return current === null ? undefined : rounds.get(current);
}

/** `state` with the round `id` gone, and no round to join when it was the one. */
function withoutRound(state: CommandsState, id: symbol): CommandsState {
  const rounds = new Map(state.rounds);
  rounds.delete(id);
  return { ...state, current: state.current === id ? null : state.current, rounds };
}
