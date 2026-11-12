// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's login, logout and cancel over one queue, so overlapping calls never reach the core twice. A login answers
// every call made in its round, and a logout runs its end in the order it was asked for.

import { createReporter, defineCount } from '@dotli/metrics';
import { createAsyncTaskPool, createStateMachine, nest, type MachineTypes } from '@dotli/shared';
import type { ReadableAtom } from 'nanostores';
import { authViews } from './session/authViews.js';
import type { DotliAuthState } from './session/types.js';
import type { TruapiSessionUiState } from './session/parseUiStateCache.js';
import type { LogoutOutcome } from './createPageSignOut.js';

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

/** The page's sign-in and sign-out on its core. */
export type AuthCommands = {
  /**
   * Answers how the login ended. A click queued behind a login shares its answer. Answers `paired` at once for a user
   * already signed in. Rejects when the core paired but its session could not be stored or read back. A call queued
   * behind a login that rejects rejects too, with that failure as its cause.
   */
  login(params?: LoginParams): Promise<LoginOutcome>;
  /**
   * Settles once the sign-out has ended, with whether the phone heard of every session this page held. A failed
   * sign-out is reported and never rejects.
   */
  logout(): Promise<LogoutOutcome>;
  /**
   * Stops the pairing under way, at once and outside the queue, and ends the login round, so a later click logs in.
   * Never throws.
   */
  cancelLogin(): void;
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
type LoginWaiter = { resolve: (outcome: LoginOutcome) => void; reject: (error: unknown) => void };

/** The calls of one login, which share how it ended. The first call is the one whose login runs. */
type LoginRound =
  | { kind: 'running'; controller: AbortController; waiters: readonly [LoginWaiter, ...LoginWaiter[]] }
  | { kind: 'settled' };

/**
 * The login rounds whose login has not ended. A round ends when its login ends or when a cancel or logout is asked
 * for, whichever comes first, so a click after either still logs in. `current` is the round a click joins, which a
 * cancel or logout clears and aborts, while the round stays until its login ends and answers its calls.
 */
type CommandsState = {
  kind: 'open';
  current: symbol | null;
  rounds: ReadonlyMap<symbol, Extract<LoginRound, { kind: 'running' }>>;
};

type CommandsEvent =
  | { kind: 'loginAsked'; reason: LoginParams['reason']; waiter: LoginWaiter }
  | { kind: 'roundEnded' }
  | { kind: 'roundAnswered'; id: symbol; outcome: LoginOutcome }
  | { kind: 'roundFailed'; id: symbol; error: unknown };

type CommandsMachine = MachineTypes<CommandsState, CommandsEvent>;

type RoundMachine = MachineTypes<LoginRound, CommandsEvent>;

/** The answer of a login that a cancel or a logout ended. */
export const CANCELLED: LoginOutcome = { kind: 'cancelled' };
/** The answer of a login whose failure was reported where it happened. */
export const FAILED: LoginOutcome = { kind: 'failed' };

const AUTH_POOL = 'auth';

const authReport = createReporter({ flow: 'wallet' });

/** A login round's transition that threw. Tagged `outcome` (error). */
const authCommandsTransitionMetric = defineCount<'error'>('auth_commands.transition');

/** Answers the calls of a round once its login ends, and lets the round leave. */
const handleRound = nest<CommandsMachine, 'open', RoundMachine, 'roundAnswered' | 'roundFailed'>({
  find: ({ rounds }, { id }) => rounds.get(id) ?? null,
  store(state, { id }, next) {
    const rounds = new Map(state.rounds);
    switch (next.kind) {
      case 'running':
        rounds.set(id, next);
        return { ...state, rounds };
      case 'settled':
        rounds.delete(id);
        return { ...state, current: state.current === id ? null : state.current, rounds };
    }
  },
  handlers: {
    running: {
      roundAnswered({ waiters }, { outcome }, { emitState }) {
        emitState({ kind: 'settled' });
        for (const waiter of waiters) {
          waiter.resolve(outcome);
        }
      },
      roundFailed({ controller, waiters: [first, ...queued] }, { error }, { emitState }) {
        emitState({ kind: 'settled' });
        first.reject(error);
        for (const waiter of queued) {
          if (controller.signal.aborted) {
            waiter.resolve(CANCELLED);
          } else {
            waiter.reject(new Error('The login this call queued behind failed', { cause: error }));
          }
        }
      },
    },
    settled: null,
  },
});

/** Returns the page's login, logout and cancel over one queue. Never throws. */
export function createAuthCommands({ auth, login, cancelPairing }: Params) {
  const queue = createAsyncTaskPool({ poolSize: 1 });
  const machine = createStateMachine<CommandsMachine>({
    initial: { kind: 'open', current: null, rounds: new Map() },
    handlers: {
      open: {
        loginAsked(state, { reason, waiter }, { emitState, update }) {
          const { current, rounds } = state;
          const joined = current === null ? undefined : rounds.get(current);
          if (current !== null && joined !== undefined) {
            // A click while a round runs shares its login, so it starts no second pairing.
            emitState({
              ...state,
              rounds: new Map(rounds).set(current, { ...joined, waiters: [...joined.waiters, waiter] }),
            });
            return;
          }
          const id = Symbol('login round');
          const controller = new AbortController();
          emitState({
            ...state,
            current: id,
            rounds: new Map(rounds).set(id, { kind: 'running', controller, waiters: [waiter] }),
          });
          update(
            queue
              .call(
                async (): Promise<LoginOutcome> => {
                  // A round a cancel or logout ended while it queued sends nothing to the core.
                  if (controller.signal.aborted) {
                    return CANCELLED;
                  }
                  const account = authViews.getSignedInSession(auth.get());
                  if (account !== null) {
                    return { kind: 'paired', account };
                  }
                  return login({ reason, signal: controller.signal });
                },
                { pool: AUTH_POOL },
              )
              .then(
                outcome => ({ kind: 'roundAnswered', id, outcome }),
                (error: unknown) => ({ kind: 'roundFailed', id, error }),
              ),
          );
        },
        roundEnded(state, _event, { emitState }) {
          const ended = state.current === null ? undefined : state.rounds.get(state.current);
          if (ended === undefined) {
            return;
          }
          emitState({ ...state, current: null });
          // A login still waiting for its core hears the abort and sends nothing.
          ended.controller.abort(new DOMException('The sign-in was cancelled', 'AbortError'));
        },
        roundAnswered: handleRound,
        roundFailed: handleRound,
      },
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
      return new Promise<LoginOutcome>((resolve, reject) => {
        machine.update({ kind: 'loginAsked', reason, waiter: { resolve, reject } });
      });
    },
    /**
     * Ends the login round and cancels a pairing under way, since the core may never answer it, then runs `end` once no
     * login is open, in the order logins and logouts were asked for, and answers what it answers. What there is to end
     * is `end`'s to decide. Rejects when `end` rejects.
     */
    logout<T>(end: () => Promise<T>): Promise<T> {
      machine.update({ kind: 'roundEnded' });
      // The logout queues behind the open login, which only the cancel ends when the core never answers it.
      if (authViews.isLoginRunning(auth.get())) {
        cancelPairing();
      }
      return queue.call(end, { pool: AUTH_POOL });
    },
    /**
     * Stops the pairing under way, at once and outside the queue, and ends the login round, so a later click logs in.
     * Never throws.
     */
    cancelLogin(): void {
      machine.update({ kind: 'roundEnded' });
      cancelPairing();
    },
  };
}
