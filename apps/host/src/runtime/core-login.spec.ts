// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import type { AuthCommands } from './auth-commands.js';
import { createCoreAuthCommands, requestCoreLogin } from './core-login.js';
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
    const provider = makeProvider({
      onPostMessage() {
        provider.listener?.(new Uint8Array([0xff, 0x00]));
      },
    });

    // When
    const login = requestCoreLogin(provider);

    // Then
    await expect(login).rejects.toThrow();
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
