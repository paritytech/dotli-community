// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createDeferred } from '@dotli/shared';
import { atom } from 'nanostores';
import { createAuthCommands, type LoginOutcome } from './createAuthCommands.js';
import type { DotliAuthState } from './session/types.js';

type Params = {
  /** The auth state the core reports when the harness starts. */
  initial: DotliAuthState;
  /** Whether the sign-out's end on the core reports the user signed out. */
  logoutSignsOut?: boolean;
  /** Whether a cancel gives the wallet answer, as the core ends a pairing it was told to drop. */
  cancelEndsLogin?: boolean;
};

type Calls = {
  /** The reason of each login that reached the core, in order. */
  logins: (string | undefined)[];
  /** The round's signal of each login that reached the core, in order. */
  signals: AbortSignal[];
  /** How many sign-out ends ran on the core. */
  logouts: number;
  /** How many pairing cancels reached the core. */
  cancels: number;
};

const PAIRING: DotliAuthState = { tag: 'Pairing', deeplink: 'polkadotapp://pair?handshake=test', label: 'x' };
const CONNECTED: DotliAuthState = { tag: 'Connected', session: { connected: true } };

/**
 * A core stand-in. Every login and logout waits for the one wallet answer the test gives with `end`, together with
 * the state the core would publish, and a run that starts after it ends at once. With `cancelEndsLogin`, a cancel
 * gives that answer too, without a state, as the core ends a pairing it was told to drop.
 */
function createQueueHarness({ initial, logoutSignsOut = false, cancelEndsLogin = false }: Params) {
  const auth = atom<DotliAuthState>(initial);
  const calls: Calls = { logins: [], signals: [], logouts: 0, cancels: 0 };
  const answer = createDeferred<LoginOutcome>();
  const commands = createAuthCommands({
    auth,
    login({ reason, signal }) {
      calls.logins.push(reason);
      calls.signals.push(signal);
      return answer.promise;
    },
    cancelPairing() {
      calls.cancels += 1;
      if (cancelEndsLogin) {
        answer.resolve({ kind: 'cancelled' });
      }
    },
  });

  async function signOut(): Promise<void> {
    calls.logouts += 1;
    await answer.promise;
    if (logoutSignsOut) {
      auth.set({ tag: 'Disconnected' });
    }
  }

  function end(state: DotliAuthState): void {
    auth.set(state);
    if (state.tag === 'Connected') {
      answer.resolve({ kind: 'paired', account: state.session });
      return;
    }
    answer.resolve({ kind: 'failed' });
  }

  return {
    /** The page's auth state the commands read. */
    auth,
    /** The commands under test. */
    commands,
    /** Every login, signal, logout and cancel the core saw. */
    calls,
    /** A sign-out's end on the core, which waits for the same wallet answer. */
    signOut,
    /** Gives the wallet answer with the state the core publishes for it. */
    end,
  };
}

describe('auth commands', () => {
  it('As a user, I click Sign in twice and both clicks hear how the one login ended', async () => {
    // Given two logins asked before the first ended
    const core = createQueueHarness({ initial: { tag: 'Disconnected' } });
    const first = core.commands.login();
    const second = core.commands.login();

    // When the core's login fails
    core.end({ tag: 'LoginFailed', kind: 'Other', reason: 'denied' });
    const outcomes = await Promise.all([first, second]);

    // Then both answer failed and the core ran one login
    expect(outcomes).toEqual([{ kind: 'failed' }, { kind: 'failed' }]);
    expect(core.calls.logins).toHaveLength(1);
  });

  it('As a user, I close the modal while a login is under way and the login hears the cancel', () => {
    // Given a login under way
    const core = createQueueHarness({ initial: { tag: 'Disconnected' } });
    void core.commands.login();

    // When the modal closes
    core.commands.cancelLogin();

    // Then the login's signal is aborted
    expect(core.calls.signals[0]?.aborted).toBe(true);
  });

  it('As a user, I click Sign in twice before the wallet answers and get one pairing', async () => {
    // Given a login waiting for the wallet
    const core = createQueueHarness({ initial: { tag: 'Disconnected' } });
    const first = core.commands.login({ reason: 'first' });

    // When a second click comes before the wallet answers
    const second = core.commands.login({ reason: 'second' });
    core.auth.set(PAIRING);
    core.end(CONNECTED);
    await Promise.all([first, second]);

    // Then the core ran only the first login
    expect(core.calls.logins).toEqual(['first']);
  });

  it('As a user, I click Sign in twice and then close the modal and no second pairing starts', async () => {
    // Given two clicks on Sign in
    const core = createQueueHarness({ initial: { tag: 'Disconnected' } });
    const first = core.commands.login();
    const second = core.commands.login();

    // When the cancel ends the first login, and the core reports the user signed out
    core.commands.cancelLogin();
    core.end({ tag: 'Disconnected' });
    await Promise.all([first, second]);

    // Then one cancel and one login reached the core
    expect(core.calls.cancels).toBe(1);
    expect(core.calls.logins).toEqual([undefined]);
  });

  it('As a user, I click Sign in while my logout finishes and my login starts once the logout ends', async () => {
    // Given a logout the core has already reported as signed out, though it has not settled yet
    const core = createQueueHarness({ initial: CONNECTED });
    const logout = core.commands.logout(core.signOut);
    core.auth.set({ tag: 'Disconnected' });
    const login = core.commands.login();

    // When the core reports signed out again as the logout ends
    core.end({ tag: 'Disconnected' });
    await Promise.all([logout, login]);

    // Then the login reached the core
    expect(core.calls.logins).toEqual([undefined]);
  });

  it('As a user, I click Sign in twice while my logout runs and get one pairing', async () => {
    // Given a logout under way and two clicks on Sign in
    const core = createQueueHarness({ initial: CONNECTED });
    const logout = core.commands.logout(core.signOut);
    const first = core.commands.login({ reason: 'first' });
    const second = core.commands.login({ reason: 'second' });

    // When the logout ends signed out
    core.end({ tag: 'Disconnected' });
    await Promise.all([logout, first, second]);

    // Then one logout and one login reached the core
    expect(core.calls.logouts).toBe(1);
    expect(core.calls.logins).toEqual(['first']);
  });

  it('As a user who closes the sign-in modal, I click Sign in again before the cancelled login settles and a new pairing starts once it does', async () => {
    // Given a login waiting for the wallet
    const core = createQueueHarness({ initial: { tag: 'Disconnected' } });
    const first = core.commands.login({ reason: 'first' });
    core.auth.set(PAIRING);

    // When the modal closes, Sign in is clicked again, then the cancelled login settles signed out
    core.commands.cancelLogin();
    const second = core.commands.login({ reason: 'second' });
    core.end({ tag: 'Disconnected' });
    await Promise.all([first, second]);

    // Then both logins reached the core
    expect(core.calls.logins).toEqual(['first', 'second']);
  });

  it('As a user who closes the sign-in modal, I click Sign in twice before the cancelled login settles and get one new pairing', async () => {
    // Given a login waiting for the wallet, which the user cancels
    const core = createQueueHarness({ initial: { tag: 'Disconnected' } });
    const first = core.commands.login({ reason: 'first' });
    core.auth.set(PAIRING);
    core.commands.cancelLogin();

    // When Sign in is clicked twice, then the cancelled login settles signed out
    const second = core.commands.login({ reason: 'second' });
    const third = core.commands.login({ reason: 'third' });
    core.end({ tag: 'Disconnected' });
    await Promise.all([first, second, third]);

    // Then the two clicks after the cancel share one new pairing
    expect(core.calls.logins).toEqual(['first', 'second']);
  });

  it('As a user, I log out and sign in again while my first login still runs and get a pairing after the logout', async () => {
    // Given a login waiting for the wallet
    const core = createQueueHarness({ initial: { tag: 'Disconnected' }, logoutSignsOut: true });
    const first = core.commands.login({ reason: 'first' });
    core.auth.set(PAIRING);

    // When Sign out, then Sign in, are pressed before the first login ends signed in
    const logout = core.commands.logout(core.signOut);
    const second = core.commands.login({ reason: 'second' });
    core.end(CONNECTED);
    await Promise.all([first, logout, second]);

    // Then one logout ran and the second login reached the core after it
    expect(core.calls.logouts).toBe(1);
    expect(core.calls.logins).toEqual(['first', 'second']);
  });

  it('As a user whose pairing the core never answers, I log out and the logout runs', async () => {
    // Given a login whose pairing only a cancel ends
    const core = createQueueHarness({ initial: { tag: 'Disconnected' }, cancelEndsLogin: true });
    const login = core.commands.login();
    core.auth.set(PAIRING);

    // When the user logs out
    await core.commands.logout(core.signOut);
    await login;

    // Then the pairing was cancelled and the logout ran
    expect(core.calls.cancels).toBe(1);
    expect(core.calls.logouts).toBe(1);
  });

  it('As a user who closed the QR code, I click Sign in before the core reports the cancel and get a new QR code', async () => {
    // Given the cancelled login has settled, but the core still reports its pairing
    const core = createQueueHarness({ initial: PAIRING });

    // When Sign in is clicked
    const login = core.commands.login();
    core.end(CONNECTED);
    await login;

    // Then a new login reached the core
    expect(core.calls.logins).toEqual([undefined]);
  });

  it('As a signed-in user, I click Sign in and no login starts', async () => {
    // Given a signed-in user
    const core = createQueueHarness({ initial: CONNECTED });

    // When Sign in is clicked
    await core.commands.login();

    // Then no login reached the core
    expect(core.calls.logins).toEqual([]);
  });

  it('As a user whose login failed, I press Retry and a new login starts', async () => {
    // Given a failed login
    const core = createQueueHarness({ initial: { tag: 'LoginFailed', kind: 'Other', reason: 'declined' } });

    // When Retry is pressed
    const retry = core.commands.login();
    core.end(CONNECTED);
    await retry;

    // Then a new login reached the core
    expect(core.calls.logins).toEqual([undefined]);
  });

  it('As a user, I press Sign out twice and each sign-out runs its end in turn and hears its own answer', async () => {
    // Given a sign-out whose end waits on the wallet
    const core = createQueueHarness({ initial: CONNECTED });
    const ends: string[] = [];
    const first = core.commands.logout(async () => {
      await core.signOut();
      ends.push('first');
      return 'first';
    });

    // When a second one is asked for before it ends
    const second = core.commands.logout(() => {
      ends.push('second');
      return Promise.resolve('second');
    });
    core.end({ tag: 'Disconnected' });
    const answers = await Promise.all([first, second]);

    // Then each ran after the one before, whatever the core reports, and what to end was each one's own call
    expect(answers).toEqual(['first', 'second']);
    expect(ends).toEqual(['first', 'second']);
  });

  it('As a user, I close the modal while the login waits for the wallet and the cancel reaches the core', () => {
    // Given a login waiting for the wallet
    const core = createQueueHarness({ initial: { tag: 'Disconnected' } });
    void core.commands.login();
    core.auth.set(PAIRING);

    // When the modal closes
    core.commands.cancelLogin();

    // Then one cancel reached the core
    expect(core.calls.cancels).toBe(1);
  });

  it('As a user whose login could not store my session, I see a click queued behind it fail with the same cause', async () => {
    // Given two logins in one round
    const failure = new Error('The paired session could not be stored');
    const answer = createDeferred<LoginOutcome>();
    const commands = createAuthCommands({
      auth: atom<DotliAuthState>({ tag: 'Disconnected' }),
      login: () => answer.promise,
      cancelPairing: () => undefined,
    });
    const first = commands.login();
    const second = commands.login();

    // When the round's login rejects
    answer.reject(failure);
    const settled = await Promise.allSettled([first, second]);

    // Then both rejected, the queued one with the failure as its cause
    expect(settled[0]).toEqual({ status: 'rejected', reason: failure });
    expect(settled[1]).toMatchObject({ status: 'rejected', reason: { cause: failure } });
  });

  it('As a user who closed the modal, I see a click queued in that round answer cancelled when its login then fails', async () => {
    // Given two logins in one round, which a close then ends
    const answer = createDeferred<LoginOutcome>();
    const commands = createAuthCommands({
      auth: atom<DotliAuthState>({ tag: 'Disconnected' }),
      login: () => answer.promise,
      cancelPairing: () => undefined,
    });
    const first = commands.login();
    const second = commands.login();
    commands.cancelLogin();

    // When the round's login rejects
    answer.reject(new Error('The paired session could not be stored'));
    const settled = await Promise.allSettled([first, second]);

    // Then the running login rejected and the queued click answered cancelled
    expect(settled[0].status).toBe('rejected');
    expect(settled[1]).toEqual({ status: 'fulfilled', value: { kind: 'cancelled' } });
  });
});
