// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { decodeWireMessage } from '@parity/truapi';
import { bindCaptureSink } from '@dotli/metrics';
import { createAuthCommands, createCoreAuthCommands, requestCoreLogin, type AuthCommands } from './core-login.js';
import type { DotliAuthState } from './session/auth-state.js';
import { createSyncStore, type SyncStore } from '@dotli/shared';
import type { WalletMode } from './state/wallet-mode.js';
import type { WalletSwitchOutcome } from './wallet-switch.js';
import {
  answerConnection,
  createFakePageCore,
  loginResponseFrame,
  makeProvider,
  requestIdFromFrame,
  type FakePageCore,
} from './page-core.fake.js';
import { CoreRedialError } from './page-core.js';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { nth } from '@dotli/shared/testing';

interface Harness extends FakePageCore {
  commands: AuthCommands;
  auth: SyncStore<DotliAuthState>;
  session: { reportLoginFailure: ReturnType<typeof vi.fn>; reportLogoutWithoutCore: ReturnType<typeof vi.fn> };
  leaveLocalWallet: ReturnType<typeof vi.fn<() => Promise<WalletSwitchOutcome>>>;
  captures: { exception: ReturnType<typeof vi.fn>; expected: ReturnType<typeof vi.fn> };
  counted: RecordingSentry['counted'];
  requestCoreLogin: typeof requestCoreLogin;
}

/** Commands over a fake page core, with a fake Sentry and capture sink bound for this test. */
function harness(
  options: { auth?: DotliAuthState; walletMode?: WalletMode; leaveOutcome?: WalletSwitchOutcome } = {},
): Harness {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const captures = { exception: vi.fn(), expected: vi.fn() };
  onTestFinished(bindCaptureSink(captures));
  const fakes = createFakePageCore();
  const auth = createSyncStore<DotliAuthState>('auth', options.auth ?? { tag: 'Disconnected' }, {
    equals: () => false,
  });
  const session = { reportLoginFailure: vi.fn(), reportLogoutWithoutCore: vi.fn() };
  const leaveLocalWallet = vi.fn(() => Promise.resolve(options.leaveOutcome ?? 'reloading'));
  const commands = createCoreAuthCommands({
    auth,
    core: fakes.core,
    session,
    walletMode: () => options.walletMode ?? 'app',
    leaveLocalWallet,
  });
  return { ...fakes, commands, auth, session, leaveLocalWallet, captures, counted: metrics.counted, requestCoreLogin };
}

const SIGNED_IN: DotliAuthState = { tag: 'Connected', session: { connected: true, publicKey: '0x01' } };

describe('topbar login over the page core', () => {
  it('As a user on the landing page, I log in and the core goes once my login is done', async () => {
    // Given
    const fakes = harness();
    void fakes.commands.login();
    const login = makeProvider({
      onPostMessage(message) {
        login.listener?.(loginResponseFrame(requestIdFromFrame(message), { success: true, value: 'Success' }));
      },
    });

    // When
    await answerConnection(fakes, 0, login);

    // Then
    await fakes.changes.until(() => (fakes.runtimes[0]?.dispose.mock.calls.length ?? 0) === 1);
    expect(login.dispose).toHaveBeenCalledTimes(1);
  });

  it('As a user who clicks Sign in twice before the wallet answers, the core gets one login request', async () => {
    // Given: a topbar login still connecting to the core
    const fakes = harness();
    const first = fakes.commands.login();
    await fakes.changes.until(() => fakes.connections.length === 1);

    // When: a second click, then the core pairs and the wallet answers
    const second = fakes.commands.login();
    const sent: string[] = [];
    const login = makeProvider({
      onPostMessage(message) {
        sent.push(requestIdFromFrame(message));
      },
    });
    await answerConnection(fakes, 0, login);
    await fakes.changes.until(() => sent.length === 1);
    fakes.auth.set({ tag: 'Pairing', deeplink: 'polkadotapp://pair?handshake=test', label: 'dotli' });
    fakes.auth.set(SIGNED_IN);
    login.listener?.(loginResponseFrame(nth(sent, 0), { success: true, value: 'Success' }));
    await first;

    // Then
    expect(fakes.connections).toHaveLength(1);
    await second;
    expect(sent).toHaveLength(1);
  });

  it('As a user who closes the login modal, the pairing under way is cancelled', async () => {
    // Given
    const fakes = harness();
    void fakes.commands.login();
    await answerConnection(fakes, 0);

    // When
    fakes.commands.cancelLogin();

    // Then
    await fakes.changes.until(() => (fakes.runtimes[0]?.cancelPairing.mock.calls.length ?? 0) === 1);
  });

  it('As an operator, a login that fails before the core answers is reported under the wallet flow', async () => {
    // Given: a topbar login whose core connection drops once the request is sent
    const fakes = harness();
    const done = fakes.commands.login();
    const failure = new Error('worker fatal error: boom');
    const login = makeProvider({
      onPostMessage() {
        login.closeListener?.(failure);
      },
    });

    // When
    await answerConnection(fakes, 0, login);
    await done;

    // Then
    expect(fakes.captures.exception).toHaveBeenCalledWith(failure, { flow: 'wallet', step: 'login' });
    expect(fakes.captures.expected).not.toHaveBeenCalled();
    expect(fakes.session.reportLoginFailure).toHaveBeenCalledWith('worker fatal error: boom');
  });

  it('As an operator, a login the user cancels leaves a breadcrumb, not an issue', async () => {
    // Given: a topbar login
    const fakes = harness();
    const done = fakes.commands.login();
    const login = makeProvider({
      onPostMessage(message) {
        login.listener?.(loginResponseFrame(requestIdFromFrame(message), { success: false, cancelled: true }));
      },
    });

    // When: the user cancels it
    await answerConnection(fakes, 0, login);
    await done;

    // Then
    expect(fakes.captures.expected).toHaveBeenCalledWith(expect.objectContaining({ name: 'LoginRequestError' }), {
      flow: 'wallet',
      step: 'login',
    });
    expect(fakes.captures.exception).not.toHaveBeenCalled();
    expect(fakes.session.reportLoginFailure).not.toHaveBeenCalled();
  });

  it('As an operator, a login that falls with a core redial the page core reported is recorded as expected, not captured again', async () => {
    // Given: the page core gave up redialing the wallet core
    const fakes = harness();
    const failure = new CoreRedialError(new Error('worker fatal error: boot'));
    fakes.nextBoots.push(() => failure);

    // When
    await fakes.commands.login();

    // Then
    expect(fakes.captures.expected).toHaveBeenCalledWith(failure, { flow: 'wallet', step: 'login' });
    expect(fakes.captures.exception).not.toHaveBeenCalled();
    expect(fakes.session.reportLoginFailure).toHaveBeenCalledWith(failure.message);
  });

  it('As a user who closes the sign-in while the wallet core still starts, no pairing starts once it is up', async () => {
    // Given: a login waiting for its connection to the core
    const fakes = harness();
    const done = fakes.commands.login();
    await fakes.changes.until(() => fakes.connections.length === 1);

    // When: the user closes the modal, then the core comes up
    fakes.commands.cancelLogin();
    const login = await answerConnection(fakes, 0);
    await fakes.changes.until(() => login.dispose.mock.calls.length === 1 || login.postMessage.mock.calls.length === 1);
    await done;

    // Then: nothing was asked of the core, and nothing is reported
    expect(login.postMessage).not.toHaveBeenCalled();
    expect(login.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.session.reportLoginFailure).not.toHaveBeenCalled();
    expect(fakes.captures.exception).not.toHaveBeenCalled();
  });

  it('As a user who logs out while a login still waits for the wallet core, no pairing starts once it is up', async () => {
    // Given: a login waiting for its connection to the core
    const fakes = harness();
    const done = fakes.commands.login();
    await fakes.changes.until(() => fakes.connections.length === 1);

    // When
    void fakes.commands.logout();
    const login = await answerConnection(fakes, 0);
    await fakes.changes.until(() => login.dispose.mock.calls.length === 1 || login.postMessage.mock.calls.length === 1);
    await done;

    // Then
    expect(login.postMessage).not.toHaveBeenCalled();
    expect(login.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.session.reportLoginFailure).not.toHaveBeenCalled();
  });

  it('As a user who closes the sign-in while the wallet core still boots, no pairing starts once it has booted', async () => {
    // Given: a login waiting for a cold wallet core to boot
    const fakes = harness();
    fakes.holdBoots();
    const done = fakes.commands.login();
    await fakes.changes.until(() => fakes.heldBoots.length === 1);

    // When: the user closes the modal, then the core finishes booting
    fakes.commands.cancelLogin();
    nth(fakes.heldBoots, 0).resolve(undefined);
    await done;

    // Then: no connection was opened, nothing was reported, and the login let the core go
    expect(fakes.connections).toHaveLength(0);
    expect(fakes.session.reportLoginFailure).not.toHaveBeenCalled();
    expect(fakes.captures.exception).not.toHaveBeenCalled();
    expect(fakes.runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('topbar logout over the page core', () => {
  it('As a dotli integrator, the host boots the page core to disconnect a stored session without a product', async () => {
    // Given
    const fakes = harness({ auth: SIGNED_IN });

    // When
    await fakes.commands.logout();

    // Then: the core disconnects, then goes with its only lease
    expect(fakes.runtimes[0]?.disconnectSession).toHaveBeenCalledTimes(1);
    expect(fakes.runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('As a user whose logout the core refuses, I stay signed in and the failure is reported', async () => {
    // Given: a signed-in user whose core cannot clear the session
    const fakes = harness({ auth: SIGNED_IN });
    const failure = new Error('session store unreachable');
    fakes.nextBoots.push(runtime => {
      runtime.disconnectSession.mockRejectedValue(failure);
      return undefined;
    });

    // When
    await fakes.commands.logout();

    // Then
    expect(fakes.captures.exception).toHaveBeenCalledWith(failure, {
      flow: 'wallet',
      step: 'logout',
      tags: { reason: 'disconnect' },
    });
    expect(fakes.counted('wallet.logout')).toEqual([{ outcome: 'error', reason: 'disconnect' }]);
    expect(fakes.session.reportLogoutWithoutCore).not.toHaveBeenCalled();
  });

  it('As a user whose wallet core never boots, I am shown logged out and the failure is reported', async () => {
    // Given
    const fakes = harness({ auth: SIGNED_IN });
    const failure = new Error('worker fatal error: boot');
    fakes.nextBoots.push(() => failure);

    // When
    await fakes.commands.logout();

    // Then
    expect(fakes.captures.exception).toHaveBeenCalledWith(failure, {
      flow: 'wallet',
      step: 'logout',
      tags: { reason: 'boot' },
    });
    expect(fakes.counted('wallet.logout')).toEqual([{ outcome: 'error', reason: 'boot' }]);
    expect(fakes.session.reportLogoutWithoutCore).toHaveBeenCalledTimes(1);
  });

  it('As an operator, a logout that falls with a core redial the page core reported is counted but not captured again', async () => {
    // Given
    const fakes = harness({ auth: SIGNED_IN });
    const failure = new CoreRedialError(new Error('worker fatal error: boot'));
    fakes.nextBoots.push(() => failure);

    // When
    await fakes.commands.logout();

    // Then
    expect(fakes.captures.expected).toHaveBeenCalledWith(failure, { flow: 'wallet', step: 'logout' });
    expect(fakes.captures.exception).not.toHaveBeenCalled();
    expect(fakes.counted('wallet.logout')).toEqual([{ outcome: 'error', reason: 'boot' }]);
    expect(fakes.session.reportLogoutWithoutCore).toHaveBeenCalledTimes(1);
  });

  it('As an operator, a logout that clears the session is counted as one', async () => {
    // Given
    const fakes = harness({ auth: SIGNED_IN });

    // When
    await fakes.commands.logout();

    // Then
    expect(fakes.counted('wallet.logout')).toEqual([{ outcome: 'ok' }]);
    expect(fakes.captures.exception).not.toHaveBeenCalled();
  });

  it('As a local wallet user, I log out by leaving local mode instead of disconnecting a session', async () => {
    // Given
    const fakes = harness({ auth: SIGNED_IN, walletMode: 'local' });

    // When
    await fakes.commands.logout();

    // Then
    expect(fakes.leaveLocalWallet).toHaveBeenCalledTimes(1);
    // No core was booted to disconnect a session.
    expect(fakes.runtimes).toHaveLength(0);
  });

  it('As a local wallet user whose switch back failed, I log out with no session disconnected and no logout counted', async () => {
    // Given: a switch that reports its own failure and answers failed
    const fakes = harness({ auth: SIGNED_IN, walletMode: 'local', leaveOutcome: 'failed' });

    // When
    await fakes.commands.logout();

    // Then: the switch's report is the only one
    expect(fakes.leaveLocalWallet).toHaveBeenCalledTimes(1);
    expect(fakes.runtimes).toHaveLength(0);
    expect(fakes.counted('wallet.logout')).toEqual([]);
    expect(fakes.captures.exception).not.toHaveBeenCalled();
    expect(fakes.session.reportLogoutWithoutCore).not.toHaveBeenCalled();
  });
});

describe('requestCoreLogin', () => {
  it('As a dotli integrator, the host resolves successful login responses', async () => {
    // Given
    const { requestCoreLogin } = harness();
    const provider = makeProvider({
      onPostMessage(message) {
        provider.listener?.(loginResponseFrame(requestIdFromFrame(message), { success: true, value: 'Success' }));
      },
    });

    // When
    const login = requestCoreLogin(provider);

    // Then
    await expect(login).resolves.toBe('Success');
    expect(provider.subscribe).toHaveBeenCalledTimes(1);
    expect(provider.listener).toBeNull();
  });

  it('As a dotli integrator, the host rejects typed login errors as LoginRequestError', async () => {
    // Given
    const { requestCoreLogin } = harness();
    const provider = makeProvider({
      onPostMessage(message) {
        provider.listener?.(loginResponseFrame(requestIdFromFrame(message), { success: false, reason: 'Rejected' }));
      },
    });

    // When
    const promise = requestCoreLogin(provider);

    // Then
    await expect(promise).rejects.toThrow('Rejected');
    await expect(promise).rejects.toMatchObject({
      name: 'LoginRequestError',
      error: {
        tag: 'Domain',
        value: {
          tag: 'V1',
          value: { tag: 'Unknown', value: { reason: 'Rejected' } },
        },
      },
    });
    expect(provider.listener).toBeNull();
  });

  it('As a dotli integrator, the host rejects host failures with the reason as the error message', async () => {
    // Given
    const { requestCoreLogin } = harness();
    const reason = 'no free statement-store slot for device registration';
    const provider = makeProvider({
      onPostMessage(message) {
        provider.listener?.(loginResponseFrame(requestIdFromFrame(message), { success: false, hostFailure: reason }));
      },
    });

    // When
    const promise = requestCoreLogin(provider);

    // Then
    await expect(promise).rejects.toThrow(reason);
    await expect(promise).rejects.toMatchObject({
      name: 'LoginRequestError',
      error: { tag: 'HostFailure', value: { reason } },
    });
    expect(provider.listener).toBeNull();
  });

  it('As a dotli integrator, the host rejects malformed response frames and unsubscribes', async () => {
    // Given
    const { requestCoreLogin } = harness();
    const malformed = new Uint8Array([0xff, 0x00]);
    const provider = makeProvider({
      onPostMessage() {
        provider.listener?.(malformed);
      },
    });

    // When
    const login = requestCoreLogin(provider);

    // Then: the login fails with the envelope's own decode error
    await expect(login).rejects.toThrow(decodeWireMessage(malformed)._unsafeUnwrapErr().message);
    expect(provider.listener).toBeNull();
  });

  it('As a dotli integrator, the host rejects send failures and unsubscribes', async () => {
    // Given
    const { requestCoreLogin } = harness();
    const provider = makeProvider({
      onPostMessage() {
        throw new Error('send failed');
      },
    });

    // When
    const login = requestCoreLogin(provider);

    // Then
    await expect(login).rejects.toThrow('send failed');
    expect(provider.listener).toBeNull();
  });

  it('As a dotli integrator, the host rejects and unsubscribes when the core provider closes', async () => {
    // Given
    const { requestCoreLogin } = harness();
    const provider = makeProvider();

    // When
    const promise = requestCoreLogin(provider);

    // Then
    expect(provider.listener).not.toBeNull();
    expect(provider.closeListener).not.toBeNull();

    // When
    provider.closeListener?.(new Error('core transport closed'));

    // Then
    await expect(promise).rejects.toThrow('core transport closed');
    expect(provider.listener).toBeNull();
    expect(provider.closeListener).toBeNull();
  });
});

const PAIRING: DotliAuthState = { tag: 'Pairing', deeplink: 'polkadotapp://pair?handshake=test', label: 'x' };
const CONNECTED: DotliAuthState = { tag: 'Connected', session: { connected: true } };

/**
 * A core stand-in. Every login and logout waits for the one wallet answer the test gives with `end`, together with
 * the state the core would publish, and a run that starts after it ends at once. With `cancelEndsLogin`, a cancel
 * gives that answer too, without a state, as the core ends a pairing it was told to drop.
 */
function queueHarness(
  initial: DotliAuthState,
  options: { logoutSignsOut?: boolean; cancelEndsLogin?: boolean } = {},
): {
  auth: SyncStore<DotliAuthState>;
  commands: AuthCommands;
  calls: { logins: (string | undefined)[]; signals: AbortSignal[]; logouts: number; cancels: number };
  end: (state: DotliAuthState) => void;
} {
  const auth = createSyncStore<DotliAuthState>('auth-test', initial, { equals: () => false });
  const calls = { logins: [] as (string | undefined)[], signals: [] as AbortSignal[], logouts: 0, cancels: 0 };
  const answer = Promise.withResolvers<undefined>();
  const commands = createAuthCommands({
    auth,
    login: (reason, signal) => {
      calls.logins.push(reason);
      calls.signals.push(signal);
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
      if (options.cancelEndsLogin === true) {
        answer.resolve(undefined);
      }
    },
  });
  const end = (state: DotliAuthState): void => {
    auth.set(state);
    answer.resolve(undefined);
  };
  return { auth, commands, calls, end };
}

describe('auth commands', () => {
  it('As a user who closes the modal, the login under way hears the cancel', () => {
    // Given
    const core = queueHarness({ tag: 'Disconnected' });
    void core.commands.login();

    // When
    core.commands.cancelLogin();

    // Then
    expect(core.calls.signals[0]?.aborted).toBe(true);
  });

  it('As a user who clicks Sign in twice before the wallet answers, I get one pairing', async () => {
    // Given: a login waiting for the wallet
    const core = queueHarness({ tag: 'Disconnected' });
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
    const core = queueHarness({ tag: 'Disconnected' });
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
    const core = queueHarness(CONNECTED);
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
    const core = queueHarness(CONNECTED);
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
    const core = queueHarness({ tag: 'Disconnected' });
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
    const core = queueHarness({ tag: 'Disconnected' });
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
    const core = queueHarness({ tag: 'Disconnected' }, { logoutSignsOut: true });
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

  it('As a user whose pairing the core never answers, I log out and the logout runs', async () => {
    // Given: a login whose pairing only a cancel ends
    const core = queueHarness({ tag: 'Disconnected' }, { cancelEndsLogin: true });
    const login = core.commands.login();
    core.auth.set(PAIRING);

    // When
    await core.commands.logout();
    await login;

    // Then
    expect(core.calls.cancels).toBe(1);
    expect(core.calls.logouts).toBe(1);
  });

  it('As a user who closed the QR code, I click Sign in before the core reports the cancel and get a new QR code', async () => {
    // Given: the cancelled login has settled, but the core still reports its pairing
    const core = queueHarness(PAIRING);

    // When
    const login = core.commands.login();
    core.end(CONNECTED);
    await login;

    // Then
    expect(core.calls.logins).toEqual([undefined]);
  });

  it('As a signed-in user, Sign in does nothing', async () => {
    // Given
    const core = queueHarness(CONNECTED);

    // When
    await core.commands.login();

    // Then
    expect(core.calls.logins).toEqual([]);
  });

  it('As a user whose login failed, Retry starts a new login', async () => {
    // Given
    const core = queueHarness({ tag: 'LoginFailed', kind: 'Other', reason: 'declined' });

    // When
    const retry = core.commands.login();
    core.end(CONNECTED);
    await retry;

    // Then
    expect(core.calls.logins).toEqual([undefined]);
  });

  it('As a user who presses Log out twice, the session is cleared once', async () => {
    // Given
    const core = queueHarness(CONNECTED);
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
    const core = queueHarness({ tag: 'Disconnected' });

    // When
    await core.commands.logout();

    // Then
    expect(core.calls.logouts).toBe(0);
  });

  it('As a user whose logout the core refused, Log out tries again', async () => {
    // Given: a logout that left the session in place
    const core = queueHarness(CONNECTED);
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
    const core = queueHarness({ tag: 'Disconnected' });
    void core.commands.login();
    core.auth.set(PAIRING);

    // When
    core.commands.cancelLogin();

    // Then
    expect(core.calls.cancels).toBe(1);
  });
});
