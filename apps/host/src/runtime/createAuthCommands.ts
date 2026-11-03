// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's login, logout and cancel over one queue, so overlapping calls never reach the core twice. A login answers
// every call made in its round, and a logout runs its end in the order it was asked for.

import { createAsyncTaskPool } from '@dotli/shared';
import type { ReadableAtom } from 'nanostores';
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
   * already signed in. Rejects when the core paired but its session could not be stored.
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
   * session could not be stored.
   */
  login: (params: CoreLoginParams) => Promise<LoginOutcome>;
  /** Stops the pairing under way on the core. Never throws. */
  cancelPairing: () => void;
};

/** The calls of one login, which share its answer. */
type LoginRound = {
  readonly controller: AbortController;
  answer: LoginOutcome | null;
};

/** The answer of a login that a cancel or a logout ended. */
export const CANCELLED: LoginOutcome = { kind: 'cancelled' };
/** The answer of a login whose failure was reported where it happened. */
export const FAILED: LoginOutcome = { kind: 'failed' };

const AUTH_POOL = 'auth';

/** Returns the page's login, logout and cancel over one queue. Never throws. */
export function createAuthCommands({ auth, login, cancelPairing }: Params) {
  const queue = createAsyncTaskPool({ poolSize: 1 });
  // A login answers every call made in its round, so a click queued behind it starts no second pairing. A round ends
  // when its login ends or when a cancel or logout is asked for, whichever comes first, so a click after either still
  // logs in. Ending a round by cancel or logout aborts it, which a login still waiting for its core hears.
  let round = createLoginRound();

  function endRound(): void {
    round.controller.abort(new DOMException('The sign-in was cancelled', 'AbortError'));
    round = createLoginRound();
  }

  return {
    /**
     * Answers how the login ended. A click queued behind a login shares its answer. Answers `paired` at once for a user
     * already signed in. Rejects when the core paired but its session could not be stored.
     */
    login({ reason }: LoginParams = {}): Promise<LoginOutcome> {
      const asked = round;
      return queue.call(
        async () => {
          if (asked.answer !== null) {
            return asked.answer;
          }
          if (asked !== round) {
            return CANCELLED;
          }
          try {
            const state = auth.get();
            if (state.tag === 'Connected') {
              asked.answer = { kind: 'paired', account: state.session };
              return asked.answer;
            }
            asked.answer = await login({ reason, signal: asked.controller.signal });
            return asked.answer;
          } finally {
            if (round === asked) {
              round = createLoginRound();
            }
          }
        },
        { pool: AUTH_POOL },
      );
    },
    /**
     * Ends the login round and cancels a pairing under way, since the core may never answer it, then runs `end` once no
     * login is open, in the order logins and logouts were asked for, and answers what it answers. What there is to end
     * is `end`'s to decide. Rejects when `end` rejects.
     */
    logout<T>(end: () => Promise<T>): Promise<T> {
      endRound();
      // The logout queues behind the open login, which only the cancel ends when the core never answers it.
      const { tag } = auth.get();
      if (tag === 'Pairing' || tag === 'Authenticating') {
        cancelPairing();
      }
      return queue.call(end, { pool: AUTH_POOL });
    },
    /**
     * Stops the pairing under way, at once and outside the queue, and ends the login round, so a later click logs in.
     * Never throws.
     */
    cancelLogin(): void {
      endRound();
      cancelPairing();
    },
  };
}

function createLoginRound(): LoginRound {
  return { controller: new AbortController(), answer: null };
}
