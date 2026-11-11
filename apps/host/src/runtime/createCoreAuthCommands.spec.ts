// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { atom } from 'nanostores';
import { nth, recordLog } from '@dotli/shared/testing';
import { bindReports } from '../testing/bindReports.js';
import { CoreRedialError } from './coreRedialError.js';
import { createCoreAuthCommands } from './createCoreAuthCommands.js';
import { LoginRequestError } from './loginRequestError.js';
import { buildLoginResponseFrame } from '../testing/buildLoginResponseFrame.js';
import { getFrameRequestId } from '../testing/getFrameRequestId.js';
import { answerConnection, createFakePageCore, createFakeProvider } from './createPageCore.fake.js';
import { createFakeStoredSession } from './session/createCoreStorage.fake.js';
import type { DotliAuthState } from './session/types.js';

type CreateHarnessParams = {
  /** The auth state the core reports at first, signed out by default. */
  auth?: DotliAuthState;
  /** Whether the page runs on a local wallet, paired by default. */
  local?: boolean;
  /** The session the page's copy holds, one by default, as a pairing stores it. */
  stored?: string | null;
};

type CreateAnsweringProviderParams = {
  /** How the core answers the login. */
  result: Parameters<typeof buildLoginResponseFrame>[1];
};

const SIGNED_IN: DotliAuthState = { tag: 'Connected', session: { connected: true, publicKey: '0x01' } };

/** Commands over a fake page core, with a fake Sentry and capture sink bound for this test. */
function createHarness({
  auth: initial = { tag: 'Disconnected' },
  local = false,
  stored = '0xsession',
}: CreateHarnessParams = {}) {
  const fakes = createFakePageCore();
  // A report notifies the fakes' changes, so a test can wait on one.
  const { captures, counted } = bindReports({ onReport: fakes.changes.notify });
  const auth = atom<DotliAuthState>(initial);
  const session = { reportLoginFailure: vi.fn() };
  // A pairing's session is stored by default, so a login completes once the core reports it.
  const storedSession = createFakeStoredSession({ blob: stored });
  const commands = createCoreAuthCommands({
    auth,
    core: fakes.core,
    session,
    isLocalWallet: () => local,
    storedSession,
  });
  return {
    ...fakes,
    /** The commands under test. */
    commands,
    /** The page's auth state, which the test sets as the core would. */
    auth,
    /** The session state the commands report a failed login to. */
    session,
    /** The page's copy, which holds the session a pairing stores. */
    storedSession,
    /** The capture sink's exception and expected-failure spies. */
    captures,
    /** The outcomes counted under a metric name. */
    counted,
  };
}

/** A connection whose core answers the login with `result` as soon as it is sent. */
function createAnsweringProvider({ result }: CreateAnsweringProviderParams) {
  const provider = createFakeProvider({
    onPostMessage(message) {
      provider.listener?.(buildLoginResponseFrame(getFrameRequestId(message), result));
    },
  });
  return provider;
}

/**
 * A login in the sign-in window whose request the core answered with success, while its session is not stored yet.
 * The page's next read of its copy finds nothing and notifies the test.
 */
async function startLoginOverEmptyStore() {
  const fakes = createHarness({ stored: null });
  let answer: unknown = null;
  const done = fakes.commands.login().then(outcome => {
    answer = outcome;
  });
  await answerConnection(fakes, 0, {
    provider: createAnsweringProvider({ result: { kind: 'success', value: 'Success' } }),
  });
  const reads = vi.spyOn(fakes.storedSession, 'readSession');
  reads.mockImplementationOnce(() => {
    fakes.changes.notify();
    return Promise.resolve({ status: 'ok', blob: null });
  });
  return { fakes, done, reads, readAnswer: (): unknown => answer };
}

/** A login whose request the core answered with success and whose connection is let go, with nothing stored. */
async function startAnsweredLogin() {
  const fakes = createHarness({ stored: null });
  const done = fakes.commands.login();
  const login = createAnsweringProvider({ result: { kind: 'success', value: 'Success' } });
  await answerConnection(fakes, 0, { provider: login });
  await fakes.changes.until(() => login.dispose.mock.calls.length === 1);
  return { fakes, done };
}

describe('topbar login over the page core', () => {
  it('As a user on the landing page, I log in and the core goes once my login is done', async () => {
    // Given a login whose core answers with success
    const fakes = createHarness();
    void fakes.commands.login();
    const login = createAnsweringProvider({ result: { kind: 'success', value: 'Success' } });

    // When the core connection comes up and the login ends
    await answerConnection(fakes, 0, { provider: login });
    await fakes.changes.until(() => (fakes.runtimes[0]?.dispose.mock.calls.length ?? 0) === 1);

    // Then the login's connection and the core are let go once
    expect(login.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('As a user, I close the login modal and the pairing under way is cancelled', async () => {
    // Given a login whose core connection is up
    const fakes = createHarness();
    void fakes.commands.login();
    await answerConnection(fakes, 0);

    // When the modal closes
    fakes.commands.cancelLogin();
    await fakes.changes.until(() => (fakes.runtimes[0]?.cancelPairing.mock.calls.length ?? 0) === 1);

    // Then the core cancels the pairing once
    expect(fakes.runtimes[0]?.cancelPairing).toHaveBeenCalledTimes(1);
  });

  it('As an operator, I see a login fail before the core answers and it is reported under the wallet flow', async () => {
    // Given: a topbar login whose core connection drops once the request is sent
    const fakes = createHarness();
    const done = fakes.commands.login();
    const failure = new Error('worker fatal error: boom');
    const login = createFakeProvider({
      onPostMessage() {
        login.closeListener?.(failure);
      },
    });

    // When the connection comes up and drops
    await answerConnection(fakes, 0, { provider: login });
    await done;

    // Then the failure is captured under the wallet flow and shown
    expect(fakes.captures.exception).toHaveBeenCalledWith(failure, expect.objectContaining({ step: 'login' }));
    expect(fakes.captures.expected).not.toHaveBeenCalled();
    expect(fakes.session.reportLoginFailure).toHaveBeenCalledWith('worker fatal error: boom');
  });

  it('As a user in the sign-in window, I log in and get no answer while the core reported me but the session is not stored', async () => {
    // Given a pairing whose session is not stored yet
    const { fakes, reads, readAnswer } = await startLoginOverEmptyStore();

    // When the core reports the account first, and the login looks at the copy
    fakes.auth.set(SIGNED_IN);
    await fakes.changes.until(() => reads.mock.calls.length === 1);

    // Then nothing is answered without the stored session
    expect(readAnswer()).toBeNull();
  });

  it('As a user in the sign-in window, I log in and my login answers paired once the session lands after the core reported me', async () => {
    // Given a login the core reported while its session is not stored yet
    const { fakes, done, reads, readAnswer } = await startLoginOverEmptyStore();
    fakes.auth.set(SIGNED_IN);
    await fakes.changes.until(() => reads.mock.calls.length === 1);

    // When the session lands
    fakes.storedSession.store('0x01');
    await done;

    // Then the login answers paired with the reported account
    expect(readAnswer()).toEqual({ kind: 'paired', account: { connected: true, publicKey: '0x01' } });
  });

  it('As a user on a local wallet, I log in and my login answers paired once the core reports me, with nothing stored', async () => {
    // Given a login on a local wallet whose core answered with success, over a copy that holds nothing
    const fakes = createHarness({ local: true, stored: null });
    const reads = vi.spyOn(fakes.storedSession, 'readSession');
    const done = fakes.commands.login();
    await answerConnection(fakes, 0, {
      provider: createAnsweringProvider({ result: { kind: 'success', value: 'Success' } }),
    });

    // When the core reports the account
    fakes.auth.set(SIGNED_IN);
    const outcome = await done;

    // Then the login answers paired with the reported account, without looking at the copy
    expect(outcome).toEqual({ kind: 'paired', account: { connected: true, publicKey: '0x01' } });
    expect(reads).not.toHaveBeenCalled();
  });

  it('As a user whose core fails the login after it answered, I wait for my login and see it failed', async () => {
    // Given a pairing whose request the core answered, with nothing stored
    const { fakes, done } = await startAnsweredLogin();

    // When the core reports the login failed
    fakes.auth.set({ tag: 'LoginFailed', kind: 'Other', reason: 'handshake failed' });
    const outcome = await done;

    // Then the login answers failed
    expect(outcome).toEqual({ kind: 'failed' });
  });

  it('As a user whose core signs out after it answered my login, I wait for my login and see it cancelled', async () => {
    // Given a login the core answered with success
    const { fakes, done } = await startAnsweredLogin();

    // When the core reports signed out
    fakes.auth.set({ tag: 'Disconnected' });
    const outcome = await done;

    // Then the login answers cancelled
    expect(outcome).toEqual({ kind: 'cancelled' });
  });

  it('As a user in the sign-in window whose paired session could not be stored, I see my login rejected and can try again', async () => {
    // Given a login the core answered with success over a store that fails
    const fakes = createHarness({ stored: null });
    const done = fakes.commands.login();
    await answerConnection(fakes, 0, {
      provider: createAnsweringProvider({ result: { kind: 'success', value: 'Success' } }),
    });

    // When the core reports the account but its write failed
    const failure = new Error('frame refused the write');
    fakes.storedSession.failWrite(failure);
    fakes.auth.set(SIGNED_IN);

    // Then the login rejects with the store's failure as its cause
    await expect(done).rejects.toMatchObject({ cause: failure });
  });

  it('As a user in the sign-in window whose paired session cannot be read back, I see my login rejected', async () => {
    // Given a login the core answered with success over a copy whose reads fail
    const fakes = createHarness();
    const done = fakes.commands.login();
    await answerConnection(fakes, 0, {
      provider: createAnsweringProvider({ result: { kind: 'success', value: 'Success' } }),
    });
    const failure = new Error('frame refused the read');
    fakes.storedSession.failReads(failure);

    // When the core reports the account
    fakes.auth.set(SIGNED_IN);

    // Then the login rejects with the read's failure as its cause
    await expect(done).rejects.toMatchObject({ message: 'The paired session could not be read back', cause: failure });
  });

  it('As an operator, I see a login the user cancels left as a breadcrumb and not as an issue', async () => {
    // Given: a topbar login
    const fakes = createHarness();
    const done = fakes.commands.login();
    const login = createAnsweringProvider({ result: { kind: 'cancelled' } });

    // When: the user cancels it
    await answerConnection(fakes, 0, { provider: login });
    const outcome = await done;

    // Then the login answers cancelled and only a breadcrumb is left
    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(fakes.captures.expected).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'LoginRequestError' }),
      expect.objectContaining({
        step: 'login',
      }),
    );
    expect(fakes.captures.exception).not.toHaveBeenCalled();
    expect(fakes.session.reportLoginFailure).not.toHaveBeenCalled();
  });

  it('As an operator, I see a login that falls with a core redial the page core reported recorded as expected and not captured again', async () => {
    // Given: the page core gave up redialing the wallet core
    const fakes = createHarness();
    const failure = new CoreRedialError(new Error('worker fatal error: boot'));
    fakes.nextBoots.push(() => failure);

    // When the user logs in
    await fakes.commands.login();

    // Then the failure is recorded as expected and shown
    expect(fakes.captures.expected).toHaveBeenCalledWith(failure, expect.objectContaining({ step: 'login' }));
    expect(fakes.captures.exception).not.toHaveBeenCalled();
    expect(fakes.session.reportLoginFailure).toHaveBeenCalledWith(failure.message);
  });

  it.each([
    { name: 'a cancelled login', failure: new LoginRequestError({ tag: 'Cancelled' }), reason: 'Cancelled' },
    { name: 'a denied login', failure: new LoginRequestError({ tag: 'Denied' }), reason: 'Denied' },
    {
      name: 'a redial the core gave up on',
      failure: new CoreRedialError(new Error('worker fatal error: boot')),
      reason: 'CoreRedialError',
    },
  ])('As an operator, I see $name counted as an expected login and not captured', async ({ failure, reason }) => {
    // Given a core that fails the login with an expected failure
    const fakes = createHarness();
    fakes.nextBoots.push(() => failure);

    // When the user logs in
    await fakes.commands.login();

    // Then the login is counted once with its reason and nothing is captured as an exception
    expect(fakes.counted('wallet.login')).toEqual([{ outcome: 'error', reason }]);
    expect(fakes.captures.exception).not.toHaveBeenCalled();
  });

  it('As an operator, I see another login refusal captured, logged and counted with its tag', async () => {
    // Given a core that refuses the login as unsupported, and a log that keeps its error lines
    const fakes = createHarness();
    const lines = recordLog({ onFinished: onTestFinished, level: 'error' });
    const failure = new LoginRequestError({ tag: 'Unsupported' });
    fakes.nextBoots.push(() => failure);

    // When the user logs in
    await fakes.commands.login();

    // Then the refusal is captured with its tag, logged once and counted with its tag
    expect(fakes.captures.exception).toHaveBeenCalledExactlyOnceWith(
      failure,
      expect.objectContaining({
        step: 'login',
        tags: { login_error: 'Unsupported' },
      }),
    );
    expect(lines.map(line => line.args)).toEqual([['[dot.li wallet] login failed:', failure]]);
    expect(fakes.counted('wallet.login')).toEqual([{ outcome: 'error', reason: 'Unsupported' }]);
  });

  it('As a user, I close the sign-in while the wallet core still starts and no pairing starts once it is up', async () => {
    // Given: a login waiting for its connection to the core
    const fakes = createHarness();
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

  it('As a user, I log out while a login still waits for the wallet core and no pairing starts once it is up', async () => {
    // Given: a login waiting for its connection to the core
    const fakes = createHarness();
    const done = fakes.commands.login();
    await fakes.changes.until(() => fakes.connections.length === 1);

    // When the user logs out, then the core comes up
    void fakes.commands.logout(() => Promise.resolve());
    const login = await answerConnection(fakes, 0);
    await fakes.changes.until(() => login.dispose.mock.calls.length === 1 || login.postMessage.mock.calls.length === 1);
    await done;

    // Then nothing was asked of the core, and nothing is reported
    expect(login.postMessage).not.toHaveBeenCalled();
    expect(login.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.session.reportLoginFailure).not.toHaveBeenCalled();
  });

  it('As a user, I close the sign-in while the wallet core still boots and no pairing starts once it has booted', async () => {
    // Given: a login waiting for a cold wallet core to boot
    const fakes = createHarness();
    fakes.holdBoots();
    const done = fakes.commands.login();
    await fakes.changes.until(() => fakes.heldBoots.length === 1);

    // When: the user closes the modal, then the core finishes booting and its late lease is let go
    fakes.commands.cancelLogin();
    nth(fakes.heldBoots, 0).resolve(undefined);
    await done;
    await fakes.changes.until(() => (fakes.runtimes[0]?.dispose.mock.calls.length ?? 0) === 1);

    // Then: no connection was opened, nothing was reported, and the login let the core go
    expect(fakes.connections).toHaveLength(0);
    expect(fakes.session.reportLoginFailure).not.toHaveBeenCalled();
    expect(fakes.captures.exception).not.toHaveBeenCalled();
    expect(fakes.runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('As a user, I close the sign-in while the wallet core still boots and can sign in again at once', async () => {
    // Given a login waiting for a cold wallet core to boot
    const fakes = createHarness();
    fakes.holdBoots();
    const first = fakes.commands.login();
    await fakes.changes.until(() => fakes.heldBoots.length === 1);

    // When the user closes the modal, the first login answers, the user signs in again and the core finishes booting
    fakes.commands.cancelLogin();
    const outcome = await first;
    void fakes.commands.login();
    nth(fakes.heldBoots, 0).resolve(undefined);
    await fakes.changes.until(() => fakes.connections.length === 1);

    // Then the first login answered cancelled, and the second one reached the core
    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(fakes.connections).toHaveLength(1);
  });

  it('As a user, I close the sign-in while the wallet core still boots and its late boot failure is still reported', async () => {
    // Given a login the user closed while a cold wallet core still boots
    const fakes = createHarness();
    fakes.holdBoots();
    const done = fakes.commands.login();
    await fakes.changes.until(() => fakes.heldBoots.length === 1);
    fakes.commands.cancelLogin();
    await done;

    // When the boot fails
    const failure = new Error('worker fatal error: boot');
    nth(fakes.heldBoots, 0).reject(failure);
    await fakes.changes.until(() => fakes.captures.exception.mock.calls.length === 1);

    // Then the failure is reported once as a login failure, and session state is not told
    expect(fakes.captures.exception).toHaveBeenCalledExactlyOnceWith(
      failure,
      expect.objectContaining({ step: 'login' }),
    );
    expect(fakes.session.reportLoginFailure).not.toHaveBeenCalled();
  });

  it('As an operator, I see a boot failure that lands in the same turn as the user closing the sign-in still reported', async () => {
    // Given: a login waiting for a cold wallet core to boot, whose user closes the sign-in as the boot's failure arrives
    const fakes = createHarness();
    fakes.holdBoots();
    const acquire = fakes.core.acquire.bind(fakes.core);
    vi.spyOn(fakes.core, 'acquire').mockImplementationOnce(() => {
      const lease = acquire();
      // Hooked a microtask late, so the close lands after the login heard the failure and before it acts on it.
      queueMicrotask(() => {
        lease.catch(() => {
          fakes.commands.cancelLogin();
        });
      });
      return lease;
    });
    const done = fakes.commands.login();
    await fakes.changes.until(() => fakes.heldBoots.length === 1);

    // When the boot fails
    const failure = new Error('worker fatal error: boot');
    nth(fakes.heldBoots, 0).reject(failure);
    await done;

    // Then the failure is reported once as a login failure
    expect(fakes.captures.exception).toHaveBeenCalledExactlyOnceWith(
      failure,
      expect.objectContaining({ step: 'login' }),
    );
  });
});
