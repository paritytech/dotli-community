// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createAuthCommands, type AuthCommands } from './auth-commands.js';
import type { DotliAuthState } from './session/auth-state.js';
import { createSyncStore, type SyncStore } from '@dotli/shared';

const PAIRING: DotliAuthState = { tag: 'Pairing', deeplink: 'polkadotapp://pair?handshake=test', label: 'x' };
const CONNECTED: DotliAuthState = { tag: 'Connected', session: { connected: true } };

/**
 * A core stand-in. Every login and logout waits for the one wallet answer the test gives with `end`, together with
 * the state the core would publish, and a run that starts after it ends at once.
 */
function harness(
  initial: DotliAuthState,
  options: { logoutSignsOut?: boolean } = {},
): {
  auth: SyncStore<DotliAuthState>;
  commands: AuthCommands;
  calls: { logins: (string | undefined)[]; logouts: number; cancels: number };
  end: (state: DotliAuthState) => void;
} {
  const auth = createSyncStore<DotliAuthState>('auth-test', initial, { equals: () => false });
  const calls = { logins: [] as (string | undefined)[], logouts: 0, cancels: 0 };
  const answer = Promise.withResolvers<undefined>();
  const commands = createAuthCommands({
    auth,
    login: reason => {
      calls.logins.push(reason);
      return answer.promise;
    },
    logout: async () => {
      calls.logouts += 1;
      await answer.promise;
      if (options.logoutSignsOut === true) {
        auth.set({ tag: 'Disconnected' });
      }
    },
    cancelPairing: () => {
      calls.cancels += 1;
    },
  });
  const end = (state: DotliAuthState): void => {
    auth.set(state);
    answer.resolve(undefined);
  };
  return { auth, commands, calls, end };
}

describe('auth commands', () => {
  it('As a user who clicks Sign in twice before the wallet answers, I get one pairing', async () => {
    // Given: a login waiting for the wallet
    const core = harness({ tag: 'Disconnected' });
    const first = core.commands.login('first');

    // When
    const second = core.commands.login('second');
    core.auth.set(PAIRING);
    core.end(CONNECTED);
    await Promise.all([first, second]);

    // Then
    expect(core.calls.logins).toEqual(['first']);
  });

  it('As a user who clicks Sign in twice and then closes the modal, no second pairing starts', async () => {
    // Given
    const core = harness({ tag: 'Disconnected' });
    const first = core.commands.login();
    const second = core.commands.login();

    // When: the cancel ends the first login, and the core reports the user signed out
    core.commands.cancelLogin();
    core.end({ tag: 'Disconnected' });
    await Promise.all([first, second]);

    // Then
    expect(core.calls.cancels).toBe(1);
    expect(core.calls.logins).toEqual([undefined]);
  });

  it('As a user who clicks Sign in while my logout finishes, my login starts once the logout ends', async () => {
    // Given: a logout the core has already reported as signed out, though it has not settled yet
    const core = harness(CONNECTED);
    const logout = core.commands.logout();
    core.auth.set({ tag: 'Disconnected' });
    const login = core.commands.login();

    // When: the core reports signed out again as the logout ends
    core.end({ tag: 'Disconnected' });
    await Promise.all([logout, login]);

    // Then
    expect(core.calls.logins).toEqual([undefined]);
  });

  it('As a user who clicks Sign in twice while my logout runs, I get one pairing', async () => {
    // Given
    const core = harness(CONNECTED);
    const logout = core.commands.logout();
    const first = core.commands.login('first');
    const second = core.commands.login('second');

    // When
    core.end({ tag: 'Disconnected' });
    await Promise.all([logout, first, second]);

    // Then
    expect(core.calls.logouts).toBe(1);
    expect(core.calls.logins).toEqual(['first']);
  });

  it('As a user who closes the sign-in modal, I click Sign in again before the cancelled login settles and a new pairing starts once it does', async () => {
    // Given: a login waiting for the wallet
    const core = harness({ tag: 'Disconnected' });
    const first = core.commands.login('first');
    core.auth.set(PAIRING);

    // When: the modal closes, Sign in is clicked again, then the cancelled login settles signed out
    core.commands.cancelLogin();
    const second = core.commands.login('second');
    core.end({ tag: 'Disconnected' });
    await Promise.all([first, second]);

    // Then
    expect(core.calls.logins).toEqual(['first', 'second']);
  });

  it('As a user who closes the sign-in modal, I click Sign in twice before the cancelled login settles and get one new pairing', async () => {
    // Given a login waiting for the wallet, which the user cancels
    const core = harness({ tag: 'Disconnected' });
    const first = core.commands.login('first');
    core.auth.set(PAIRING);
    core.commands.cancelLogin();

    // When Sign in is clicked twice, then the cancelled login settles signed out
    const second = core.commands.login('second');
    const third = core.commands.login('third');
    core.end({ tag: 'Disconnected' });
    await Promise.all([first, second, third]);

    // Then the two clicks after the cancel share one new pairing
    expect(core.calls.logins).toEqual(['first', 'second']);
  });

  it('As a user who logs out and signs in again while my first login still runs, I get a pairing after the logout', async () => {
    // Given: a login waiting for the wallet
    const core = harness({ tag: 'Disconnected' }, { logoutSignsOut: true });
    const first = core.commands.login('first');
    core.auth.set(PAIRING);

    // When: Log out, then Sign in, are pressed before the first login ends signed in
    const logout = core.commands.logout();
    const second = core.commands.login('second');
    core.end(CONNECTED);
    await Promise.all([first, logout, second]);

    // Then
    expect(core.calls.logouts).toBe(1);
    expect(core.calls.logins).toEqual(['first', 'second']);
  });

  it.each([PAIRING, { tag: 'Authenticating' } as const, CONNECTED])(
    'As a user, Sign in does nothing while the auth state is $tag',
    async state => {
      // Given
      const core = harness(state);

      // When
      await core.commands.login();

      // Then
      expect(core.calls.logins).toEqual([]);
    },
  );

  it('As a user whose login failed, Retry starts a new login', async () => {
    // Given
    const core = harness({ tag: 'LoginFailed', kind: 'Other', reason: 'declined' });

    // When
    const retry = core.commands.login();
    core.end(CONNECTED);
    await retry;

    // Then
    expect(core.calls.logins).toEqual([undefined]);
  });

  it('As a user who presses Log out twice, the session is cleared once', async () => {
    // Given
    const core = harness(CONNECTED);
    const first = core.commands.logout();

    // When
    const second = core.commands.logout();
    core.end({ tag: 'Disconnected' });
    await Promise.all([first, second]);

    // Then
    expect(core.calls.logouts).toBe(1);
  });

  it('As a signed-out user, Log out does nothing', async () => {
    // Given
    const core = harness({ tag: 'Disconnected' });

    // When
    await core.commands.logout();

    // Then
    expect(core.calls.logouts).toBe(0);
  });

  it('As a user whose logout the core refused, Log out tries again', async () => {
    // Given: a logout that left the session in place
    const core = harness(CONNECTED);
    const first = core.commands.logout();
    core.end(CONNECTED);
    await first;

    // When
    await core.commands.logout();

    // Then
    expect(core.calls.logouts).toBe(2);
  });

  it('As a user closing the modal, the cancel reaches the core while the login still waits for the wallet', () => {
    // Given
    const core = harness({ tag: 'Disconnected' });
    void core.commands.login();
    core.auth.set(PAIRING);

    // When
    core.commands.cancelLogin();

    // Then
    expect(core.calls.cancels).toBe(1);
  });
});
