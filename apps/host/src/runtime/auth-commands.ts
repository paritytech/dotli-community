// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The topbar's login, logout and cancel. Login and logout share one queue, so overlapping calls never reach the core twice.

import { createAsyncTaskPool, type ReadableStore } from '@dotli/shared';
import type { DotliAuthState } from './host-callbacks/AuthState.js';
import { isLoginActive } from './state/auth.js';

export interface AuthCommands {
  /** Settles once the login has ended. A no-op while a login is under way or the user is signed in. */
  login(reason?: string): Promise<void>;
  /** Settles once the logout has ended. A no-op once the user is signed out. */
  logout(): Promise<void>;
  /** Stops the pairing under way, at once and outside the queue, and ends the login round, so a later click logs in. */
  cancelLogin(): void;
}

export interface AuthCommandsDeps {
  auth: ReadableStore<DotliAuthState>;
  /** One login to its end, reporting its own failures. */
  login(reason: string | undefined): Promise<void>;
  /** One logout to its end, reporting its own failures. */
  logout(): Promise<void>;
  cancelPairing(): void;
}

const AUTH_POOL = 'auth';

export function createAuthCommands(deps: AuthCommandsDeps): AuthCommands {
  const queue = createAsyncTaskPool({ poolSize: 1 });
  // A login answers every call made in its round, so a click queued behind it starts no second pairing. A round ends
  // when its login ends or when a cancel or logout is asked for, whichever comes first, so a click after either still
  // logs in.
  let round = {};
  return {
    login(reason) {
      const asked = round;
      return queue.call(
        async () => {
          if (asked !== round) {
            return;
          }
          try {
            if (!isLoginActive(deps.auth.get())) {
              await deps.login(reason);
            }
          } finally {
            if (round === asked) {
              round = {};
            }
          }
        },
        { pool: AUTH_POOL },
      );
    },
    logout() {
      round = {};
      return queue.call(
        async () => {
          if (deps.auth.get().tag === 'Disconnected') {
            return;
          }
          await deps.logout();
        },
        { pool: AUTH_POOL },
      );
    },
    cancelLogin() {
      round = {};
      deps.cancelPairing();
    },
  };
}
