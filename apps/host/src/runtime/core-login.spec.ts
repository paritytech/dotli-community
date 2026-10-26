// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import {
  createAuthCommands,
  createCoreAuthCommands,
  requestCoreLogin,
  type CoreCommands,
  type LoginOutcome,
} from './core-login.js';
import type { DotliAuthState } from './session/auth-state.js';
import { createSyncStore, type SyncStore } from '@dotli/shared';
import type { WalletMode } from './state/wallet-mode.js';
import { createFakeStoredSession, type FakeStoredSession } from './session/core-storage.fake.js';
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
  commands: CoreCommands;
  auth: SyncStore<DotliAuthState>;
  session: { reportLoginFailure: ReturnType<typeof vi.fn> };
  /** The page's copy, which holds the session a pairing stores. */
  storedSession: FakeStoredSession;
  captures: { exception: ReturnType<typeof vi.fn>; expected: ReturnType<typeof vi.fn> };
  counted: RecordingSentry['counted'];
  requestCoreLogin: typeof requestCoreLogin;
}

/** Commands over a fake page core, with a fake Sentry and capture sink bound for this test. */
function harness(
  options: {
    auth?: DotliAuthState;
    walletMode?: WalletMode;
    /** The session the page's copy holds, one by default, as a pairing stores it. */
    stored?: string | null;
  } = {},
): Harness {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const captures = { exception: vi.fn(), expected: vi.fn() };
  onTestFinished(bindCaptureSink(captures));
  const fakes = createFakePageCore();
  const auth = createSyncStore<DotliAuthState>('auth', options.auth ?? { tag: 'Disconnected' }, {
    equals: () => false,
  });
  const session = { reportLoginFailure: vi.fn() };
  // A pairing's session is stored by default, so a login completes once the core reports it.
  const storedSession = createFakeStoredSession(options.stored === undefined ? '0xsession' : options.stored);
  const commands = createCoreAuthCommands({
    auth,
    core: fakes.core,
    session,
    walletMode: () => options.walletMode ?? 'app',
    storedSession,
  });
  return {
    ...fakes,
    commands,
    auth,
    session,
    storedSession,
    captures,
    counted: metrics.counted,
    requestCoreLogin,
  };
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

  it('As a user in the sign-in window, I log in and my login answers paired only once the core reported me and the session is stored', async () => {
    // Given a pairing whose session is not stored yet
    const fakes = harness({ stored: null });
    let answer: unknown = null;
    const done = fakes.commands.login().then(outcome => {
      answer = outcome;
    });
    const login = makeProvider({
      onPostMessage(message) {
        login.listener?.(loginResponseFrame(requestIdFromFrame(message), { success: true, value: 'Success' }));
      },
    });
    await answerConnection(fakes, 0, login);

    // When the core reports the account first, and the login looks at the copy
    const reads = vi.spyOn(fakes.storedSession, 'readSession');
    reads.mockImplementationOnce(() => {
      fakes.changes.notify();
      return Promise.resolve({ status: 'ok', blob: null });
    });
    fakes.auth.set(SIGNED_IN);
    await fakes.changes.until(() => reads.mock.calls.length === 1);

    // Then nothing is answered without the stored session
    expect(answer).toBeNull();

    // When the session lands
    fakes.storedSession.store('0x01');
    await done;

    // Then the login answers paired with the reported account
    expect(answer).toEqual({ kind: 'paired', account: { connected: true, publicKey: '0x01' } });
  });

  it('As a user whose core fails the login after it answered, I see my login answer failed and a new one pairs again', async () => {
    // Given a pairing whose request the core answered, with nothing stored
    const fakes = harness({ stored: null });
    const done = fakes.commands.login();
    const login = makeProvider({
      onPostMessage(message) {
        login.listener?.(loginResponseFrame(requestIdFromFrame(message), { success: true, value: 'Success' }));
      },
    });
    await answerConnection(fakes, 0, login);
    await fakes.changes.until(() => login.dispose.mock.calls.length === 1);

    // When the core reports the login failed
    fakes.auth.set({ tag: 'LoginFailed', kind: 'Other', reason: 'handshake failed' });

    // Then the login answers failed
    expect(await done).toEqual({ kind: 'failed' });

    // When the user tries again
    void fakes.commands.login();

    // Then a new login reaches the core
    await fakes.changes.until(() => fakes.connections.length === 2);
  });

  it('As a user whose core signs out after it answered my login, I see my login answer cancelled', async () => {
    // Given a login the core answered with success
    const fakes = harness({ stored: null });
    const done = fakes.commands.login();
    const login = makeProvider({
      onPostMessage(message) {
        login.listener?.(loginResponseFrame(requestIdFromFrame(message), { success: true, value: 'Success' }));
      },
    });
    await answerConnection(fakes, 0, login);
    await fakes.changes.until(() => login.dispose.mock.calls.length === 1);

    // When the core reports signed out
    fakes.auth.set({ tag: 'Disconnected' });

    // Then the login answers cancelled
    expect(await done).toEqual({ kind: 'cancelled' });
  });

  it('As a user in the sign-in window whose paired session could not be stored, I see my login rejected and can try again', async () => {
    // Given a login the core answered with success over a store that fails
    const fakes = harness({ stored: null });
    const done = fakes.commands.login();
    const login = makeProvider({
      onPostMessage(message) {
        login.listener?.(loginResponseFrame(requestIdFromFrame(message), { success: true, value: 'Success' }));
      },
    });
    await answerConnection(fakes, 0, login);

    // When the core reports the account but its write failed
    const failure = new Error('frame refused the write');
    fakes.storedSession.failWrite(failure);
    fakes.auth.set(SIGNED_IN);

    // Then the login rejects with the store's failure as its cause
    await expect(done).rejects.toMatchObject({ cause: failure });
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

    // Then
    expect(await done).toEqual({ kind: 'cancelled' });
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
    void fakes.commands.logout(() => Promise.resolve());
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

  it('As a dotli integrator, the host skips a frame that does not decode and still takes the login answer after it', async () => {
    // Given a core that sends a frame that does not decode before its answer
    const { requestCoreLogin } = harness();
    const provider = makeProvider({
      onPostMessage(message) {
        provider.listener?.(new Uint8Array([0xff, 0x00]));
        provider.listener?.(loginResponseFrame(requestIdFromFrame(message), { success: true, value: 'Success' }));
      },
    });

    // When
    const login = requestCoreLogin(provider);

    // Then
    await expect(login).resolves.toBe('Success');
    expect(provider.listener).toBeNull();
  });

  it('As an operator, frames that do not decode during a login are reported once and the login still resolves', async () => {
    // Given a core that sends two frames that do not decode before its answer
    const { requestCoreLogin, captures, counted } = harness();
    const provider = makeProvider({
      onPostMessage(message) {
        provider.listener?.(new Uint8Array([0xff, 0x00]));
        provider.listener?.(new Uint8Array([0xfe]));
        provider.listener?.(loginResponseFrame(requestIdFromFrame(message), { success: true, value: 'Success' }));
      },
    });

    // When
    const login = requestCoreLogin(provider);

    // Then
    await expect(login).resolves.toBe('Success');
    expect(captures.expected).toHaveBeenCalledTimes(1);
    expect(captures.expected).toHaveBeenCalledWith(expect.anything(), { flow: 'wallet', step: 'login_frame' });
    expect(counted('wallet.login_frame')).toEqual([{ outcome: 'error', reason: 'undecodable_frame' }]);
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
  commands: CoreCommands;
  calls: { logins: (string | undefined)[]; signals: AbortSignal[]; logouts: number; cancels: number };
  /** A sign-out's end on the core, which waits for the same wallet answer. */
  signOut: () => Promise<void>;
  end: (state: DotliAuthState) => void;
} {
  const auth = createSyncStore<DotliAuthState>('auth-test', initial, { equals: () => false });
  const calls = { logins: [] as (string | undefined)[], signals: [] as AbortSignal[], logouts: 0, cancels: 0 };
  const answer = Promise.withResolvers<LoginOutcome>();
  const commands = createAuthCommands({
    auth,
    login: (reason, signal) => {
      calls.logins.push(reason);
      calls.signals.push(signal);
      return answer.promise;
    },
    cancelPairing: () => {
      calls.cancels += 1;
      if (options.cancelEndsLogin === true) {
        answer.resolve({ kind: 'cancelled' });
      }
    },
  });
  const signOut = async (): Promise<void> => {
    calls.logouts += 1;
    await answer.promise;
    if (options.logoutSignsOut === true) {
      auth.set({ tag: 'Disconnected' });
    }
  };
  const end = (state: DotliAuthState): void => {
    auth.set(state);
    answer.resolve(state.tag === 'Connected' ? { kind: 'paired', account: state.session } : { kind: 'failed' });
  };
  return { auth, commands, calls, signOut, end };
}

describe('auth commands', () => {
  it('As a user, I click Sign in twice and both clicks hear how the one login ended', async () => {
    // Given two logins asked before the first ended
    const core = queueHarness({ tag: 'Disconnected' });
    const first = core.commands.login();
    const second = core.commands.login();

    // When the core's login fails
    core.end({ tag: 'LoginFailed', kind: 'Other', reason: 'denied' });

    // Then both answer failed and the core ran one login
    expect(await first).toEqual({ kind: 'failed' });
    expect(await second).toEqual({ kind: 'failed' });
    expect(core.calls.logins).toHaveLength(1);
  });

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
    const logout = core.commands.logout(core.signOut);
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
    const logout = core.commands.logout(core.signOut);
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

    // When: Sign out, then Sign in, are pressed before the first login ends signed in
    const logout = core.commands.logout(core.signOut);
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
    await core.commands.logout(core.signOut);
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

  it('As a user, I press Sign out twice and each sign-out runs its end in turn and hears its own answer', async () => {
    // Given a sign-out whose end waits on the wallet
    const core = queueHarness(CONNECTED);
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

    // Then each ran after the one before, whatever the core reports, and what to end was each one's own call
    expect(await Promise.all([first, second])).toEqual(['first', 'second']);
    expect(ends).toEqual(['first', 'second']);
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
