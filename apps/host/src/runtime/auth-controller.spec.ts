// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { withActiveTld } from '@dotli/config';
import { bindCaptureSink, type CaptureContext } from '@dotli/metrics';
import type { AuthCommands } from './core-login.js';
import {
  createAuthController,
  disableAuthModal,
  friendlyAuthError,
  initAuthController,
  startLogin,
  type AuthController,
} from './auth-controller.js';
import {
  createBlockingModalCoordinator,
  type BlockingModalCoordinator,
  type BlockingModalScope,
} from './blocking-modal-queue.js';
import type { DotliAuthState } from './session/auth-state.js';
import { authModalStore, resetAuthModal, type AuthModalState } from '../state/auth-modal.js';
import { setAuthState } from './state/auth.js';
import { createSyncStore, type SyncStore } from '@dotli/shared';
import { nth, resetAllStoresForTests } from '@dotli/shared/testing';
import { setProductLoaded } from './state/product.js';
import { createChanges, type Changes } from '../testing/changes.js';

const CLOSED_MODAL: AuthModalState = { open: false, productLabel: null, reason: null, view: { kind: 'spinner' } };
const getAuthModalState = authModalStore.get;

interface Started {
  controller: AuthController;
  auth: SyncStore<DotliAuthState>;
  coordinator: BlockingModalCoordinator;
  /** What the controller asked of the bridge chunk's commands. */
  calls: { logins: (string | undefined)[]; logouts: number; cancels: number };
  /** Notified at each command asked and each change of the auth modal. */
  changes: Changes;
}

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  resetAuthModal();
});

/** A controller over its own auth store, whose commands only record what they are asked. */
function start(
  options: { coordinator?: BlockingModalCoordinator; commands?: () => Promise<AuthCommands> } = {},
): Started {
  const auth = createSyncStore<DotliAuthState>('auth-test', { tag: 'Restoring' }, { equals: () => false });
  const calls = { logins: [] as (string | undefined)[], logouts: 0, cancels: 0 };
  const changes = createChanges();
  disposers.push(authModalStore.subscribe(changes.notify));
  const commands: AuthCommands = {
    login: reason => {
      calls.logins.push(reason);
      changes.notify();
      return Promise.resolve();
    },
    logout: () => {
      calls.logouts += 1;
      changes.notify();
      return Promise.resolve();
    },
    cancelLogin: () => {
      calls.cancels += 1;
      changes.notify();
    },
  };
  const coordinator = options.coordinator ?? createBlockingModalCoordinator();
  const controller = createAuthController({
    coordinator,
    commands: options.commands ?? (() => Promise.resolve(commands)),
    auth,
  });
  disposers.push(() => {
    controller.dispose();
  });
  return { controller, auth, coordinator, calls, changes };
}

/**
 * Holds each task until the test runs it, to force races. Dispose never aborts, as when a queue
 * starts a task before it processes that scope's disposal.
 */
function manualCoordinator(): {
  coordinator: BlockingModalCoordinator;
  tasks: { run: () => Promise<void>; disposed: () => boolean }[];
} {
  const tasks: { run: () => Promise<void>; disposed: () => boolean }[] = [];
  const coordinator: BlockingModalCoordinator = {
    createScope(): BlockingModalScope {
      const signal = new AbortController().signal;
      let disposed = false;
      return {
        enqueue<T>(task: (signal: AbortSignal) => Promise<T> | T): Promise<T> {
          return new Promise<T>(resolve => {
            tasks.push({
              run: async () => {
                resolve(await task(signal));
              },
              disposed: () => disposed,
            });
          });
        },
        dispose(): void {
          disposed = true;
        },
      };
    },
  };
  return { coordinator, tasks };
}

const pairing = {
  tag: 'Pairing',
  deeplink: 'polkadotapp://pair?handshake=test',
  label: 'localhost:3000',
} as const;

describe('auth controller: login requests', () => {
  it('As a product asking for a sign-in, the modal shows my label and reason and the core is asked to log in', async () => {
    // Given
    const { controller, auth, calls, changes } = start();
    auth.set({ tag: 'Disconnected' });

    // When
    controller.startLogin('Sign the transfer', 'localhost:3000');

    // Then
    expect(getAuthModalState()).toEqual({
      open: true,
      productLabel: 'localhost:3000',
      reason: 'Sign the transfer',
      view: { kind: 'spinner' },
    });
    await changes.until(() => calls.logins.length === 1);
    expect(calls.logins).toEqual(['Sign the transfer']);
  });

  it("As a product, a deployed label gets the active network's TLD in the modal title", () => {
    // Given
    const { controller } = start();

    // When
    controller.startLogin(undefined, 'foo');

    // Then
    expect(getAuthModalState().productLabel).toBe(withActiveTld('foo'));
    expect(getAuthModalState().reason).toBeNull();
  });

  it('As a user asking for a sign-in while the saved session cannot be reached, I get no modal and no pairing', () => {
    // Given
    const { controller, auth, calls } = start();
    auth.set({ tag: 'Unreachable' });

    // When
    controller.startLogin(undefined, 'foo');

    // Then
    expect(getAuthModalState().open).toBe(false);
    expect(calls.logins).toEqual([]);
  });

  it('As a user who clicks Sign in again while the QR is shown, the QR stays and the core is asked once', async () => {
    // Given: a login whose pairing QR is on screen
    const { controller, auth, calls, changes } = start();
    auth.set({ tag: 'Disconnected' });
    controller.startLogin();
    auth.set(pairing);

    // When
    controller.startLogin();

    // Then
    expect(getAuthModalState().view).toEqual({ kind: 'pairing', payload: pairing.deeplink });
    await changes.until(() => calls.logins.length === 1);
    expect(calls.logins).toEqual([undefined]);
  });

  it('As a user who closed the QR code, I click Sign in before the core reports the cancel and get a new QR code', async () => {
    // Given: a QR code the user closed, while the core still reports the pairing
    const { controller, auth, calls, changes } = start();
    auth.set({ tag: 'Disconnected' });
    controller.startLogin();
    auth.set(pairing);
    await changes.until(() => calls.logins.length === 1);
    controller.closeAuthModal();
    await changes.until(() => calls.cancels === 1);

    // When
    controller.startLogin();

    // Then: the modal opens and the core is asked again, so its next pairing shows a new QR code
    await changes.until(() => calls.logins.length === 2);
    expect(getAuthModalState()).toMatchObject({ open: true, view: { kind: 'spinner' } });
    auth.set({ ...pairing, deeplink: 'polkadotapp://pair?handshake=again' });
    expect(getAuthModalState().view).toEqual({ kind: 'pairing', payload: 'polkadotapp://pair?handshake=again' });
  });

  it('As a user with the QR code open, a second Sign in click starts no second pairing', async () => {
    // Given: the QR code of a pairing the core started
    const { controller, auth, calls, changes } = start();
    auth.set({ tag: 'Disconnected' });
    auth.set(pairing);

    // When: Sign in is clicked, then the modal is closed
    controller.startLogin();
    controller.closeAuthModal();

    // Then: the cancel the close asked for arrived, and no login came before it
    await changes.until(() => calls.cancels === 1);
    expect(calls.logins).toEqual([]);
  });

  it('As the error view, retryLogin re-opens the spinner and asks the core to log in again', async () => {
    // Given
    const { controller, auth, calls, changes } = start();
    auth.set({ tag: 'LoginFailed', kind: 'Other', reason: 'Host failure' });

    // When
    controller.startLogin();

    // Then
    expect(getAuthModalState().view).toEqual({ kind: 'spinner' });
    expect(getAuthModalState().open).toBe(true);
    await changes.until(() => calls.logins.length === 1);
    expect(calls.logins).toEqual([undefined]);
  });

  it('As the error view, a retry that fails the same way shows the error again', () => {
    // Given: a login failed, and the user retried.
    const { controller, auth } = start();
    const failed = {
      tag: 'LoginFailed',
      kind: 'Other',
      reason: 'worker init failed',
    } as const;
    auth.set({ ...failed });
    controller.startLogin();
    expect(getAuthModalState().view).toEqual({ kind: 'spinner' });

    // When: the bridge reports the same failure again.
    auth.set({ ...failed });

    // Then
    expect(getAuthModalState().view).toMatchObject({
      kind: 'error',
      message: 'worker init failed',
    });
  });

  it('As a user whose bridge chunk failed at boot, my sign-in clicks show the failure but open no new issue', async () => {
    // Given
    const exceptions: [unknown, CaptureContext][] = [];
    disposers.push(
      bindCaptureSink({
        exception: (error, context) => {
          exceptions.push([error, context]);
        },
        expected: () => undefined,
      }),
    );
    const failure = new TypeError('Failed to fetch dynamically imported module');
    const { controller, auth, changes } = start({ commands: () => Promise.reject(failure) });
    auth.set({ tag: 'Disconnected' });

    // When
    controller.startLogin();

    // Then
    await changes.until(() => getAuthModalState().view.kind === 'error');
    expect(getAuthModalState().view).toMatchObject({ kind: 'error', title: 'The sign-in service did not start' });
    expect(exceptions).toEqual([]);
  });

  it('As a user whose sign-in fails inside the bridge, the failure is still reported', async () => {
    // Given
    const exceptions: [unknown, CaptureContext][] = [];
    disposers.push(
      bindCaptureSink({
        exception: (error, context) => {
          exceptions.push([error, context]);
        },
        expected: () => undefined,
      }),
    );
    const failure = new Error('login exploded');
    const failing: AuthCommands = {
      login: () => Promise.reject(failure),
      logout: () => Promise.resolve(),
      cancelLogin: () => undefined,
    };
    const { controller, auth, changes } = start({ commands: () => Promise.resolve(failing) });
    auth.set({ tag: 'Disconnected' });

    // When
    controller.startLogin();

    // Then
    await changes.until(() => exceptions.length === 1);
    expect(exceptions).toEqual([[failure, { flow: 'wallet', step: 'login' }]]);
  });

  it('As the account popover, Log out asks the core to log out', async () => {
    // Given
    const { controller, calls, changes } = start();

    // When
    controller.logout();

    // Then
    await changes.until(() => calls.logouts === 1);
  });

  it('As a user who closes the sign-in modal after a failed login, the page shows it closed with nothing left over', async () => {
    // Given
    const { controller, auth, changes } = start({ commands: () => Promise.reject(new Error('worker failed')) });
    auth.set({ tag: 'Disconnected' });
    controller.startLogin('Sign in to continue', 'shop');
    await changes.until(() => getAuthModalState().view.kind === 'error');

    // When
    controller.closeAuthModal();

    // Then
    expect(getAuthModalState()).toEqual(CLOSED_MODAL);
  });
});

describe('auth controller: blocking-modal lease', () => {
  it('As the auth modal, I wait for an active blocking prompt before opening', async () => {
    // Given
    const { controller, coordinator } = start();
    const scope = coordinator.createScope();
    const { promise: held, resolve: releasePrompt }: PromiseWithResolvers<void> = Promise.withResolvers();
    const prompt = scope.enqueue(() => held);

    // When
    controller.openAuthModal();

    // Then
    expect(getAuthModalState().open).toBe(false);

    // When
    releasePrompt();
    await prompt;

    // Then
    expect(getAuthModalState().open).toBe(true);
    controller.closeAuthModal();
    scope.dispose();
  });

  it('As the auth modal, of two overlapping requests only the newest scope holds the lease', async () => {
    // Given
    const { coordinator, tasks } = manualCoordinator();
    const { controller } = start({ coordinator });
    controller.openAuthModal();
    controller.closeAuthModal({ skipTruapiCancel: true });
    controller.openAuthModal();
    expect(tasks).toHaveLength(2);
    const stale = nth(tasks, 0);
    const current = nth(tasks, 1);

    expect(stale.disposed()).toBe(true);

    // When: the replaced scope's task starts with a live signal
    await stale.run();

    // Then: it resolves at once and never opens the modal
    expect(getAuthModalState().open).toBe(false);

    // When
    const running = current.run();

    // Then
    expect(getAuthModalState().open).toBe(true);

    // When: closing releases the newest scope's lease
    controller.closeAuthModal({ skipTruapiCancel: true });
    await running;

    // Then
    expect(getAuthModalState().open).toBe(false);
  });

  it('As the auth modal, a second open while a lease is pending reuses it', async () => {
    // Given
    const { coordinator, tasks } = manualCoordinator();
    const { controller } = start({ coordinator });
    controller.openAuthModal();
    controller.openAuthModal('again');

    // When: the one pending lease is granted
    const running = nth(tasks, 0).run();

    // Then: the modal opens with the second call's reason
    expect(getAuthModalState()).toMatchObject({ open: true, reason: 'again' });
    expect(tasks).toHaveLength(1);

    // When: one close
    controller.closeAuthModal({ skipTruapiCancel: true });
    await running;

    // Then: it releases the lease
    expect(getAuthModalState().open).toBe(false);
  });

  it('As the user, closing the modal releases the lease and cancels the in-flight login once', async () => {
    // Given
    const { controller, coordinator, calls, changes } = start();
    controller.openAuthModal('why', 'localhost:3000');
    expect(getAuthModalState().open).toBe(true);
    const next = coordinator.createScope();
    let nextRan = false;

    // When
    const queued = next.enqueue(() => {
      nextRan = true;
    });
    controller.closeAuthModal();
    await queued;

    // Then
    await changes.until(() => calls.cancels === 1);
    expect(nextRan).toBe(true);
    expect(getAuthModalState()).toEqual({
      open: false,
      productLabel: null,
      reason: null,
      view: { kind: 'spinner' },
    });
    next.dispose();
  });

  it('As the core, a Connected close does not cancel the login', async () => {
    // Given
    const { controller, calls, changes } = start();
    controller.openAuthModal();

    // When
    controller.closeAuthModal({ skipTruapiCancel: true });
    controller.logout();

    // Then: the logout behind it ran, and no cancel came before it
    await changes.until(() => calls.logouts === 1);
    expect(calls.cancels).toBe(0);
    expect(getAuthModalState().open).toBe(false);
  });

  it('As the host, disabling the modal while a login holds the lease releases it and cancels that login once; later opens and retries cancel instead of presenting', async () => {
    // Given
    const { controller, coordinator, calls, auth, changes } = start();
    auth.set({ tag: 'Disconnected' });
    controller.openAuthModal('why', 'localhost:3000');
    expect(getAuthModalState().open).toBe(true);
    const next = coordinator.createScope();
    let nextRan = false;
    const queued = next.enqueue(() => {
      nextRan = true;
    });

    // When
    controller.disableAuthModal();
    await queued;

    // Then
    await changes.until(() => calls.cancels === 1);
    expect(nextRan).toBe(true);
    expect(getAuthModalState().open).toBe(false);

    // When
    const presented = controller.openAuthModal();
    controller.startLogin();

    // Then
    expect(presented).toBe(false);
    await changes.until(() => calls.cancels === 3);
    expect(calls.logins).toEqual([]);
    expect(getAuthModalState().open).toBe(false);
    next.dispose();
  });

  it('As the host, disabling the modal with no login in flight cancels nothing', async () => {
    // Given
    const { controller, calls, changes } = start();

    // When
    controller.disableAuthModal();
    controller.logout();

    // Then: the logout ran, and no cancel came before it
    await changes.until(() => calls.logouts === 1);
    expect(calls.cancels).toBe(0);
  });

  it('As the host, an auth modal island that failed before boot started the controller keeps the modal disabled', async () => {
    // Given: the island failed first
    disableAuthModal();

    // When
    const cancels: string[] = [];
    const changes = createChanges();
    const controller = initAuthController({
      coordinator: createBlockingModalCoordinator(),
      commands: () =>
        Promise.resolve({
          login: () => Promise.resolve(),
          logout: () => Promise.resolve(),
          cancelLogin: () => {
            cancels.push('cancel');
            changes.notify();
          },
        }),
    });
    disposers.push(resetAllStoresForTests);

    // Then
    expect(controller.openAuthModal()).toBe(false);
    await changes.until(() => cancels.length === 1);
    expect(cancels).toEqual(['cancel']);
  });
});

describe('auth controller: auth states', () => {
  it('As the core, Pairing opens the modal with the QR payload and the product label', () => {
    // Given
    const { auth } = start();

    // When
    auth.set(pairing);

    // Then
    expect(getAuthModalState()).toEqual({
      open: true,
      productLabel: 'localhost:3000',
      reason: null,
      view: { kind: 'pairing', payload: 'polkadotapp://pair?handshake=test' },
    });
  });

  it('As the landing page, a host-global Pairing has no product label', () => {
    // Given
    const { auth } = start();

    // When
    auth.set({
      ...pairing,
      label: 'Polkadot Web',
      dotSuffix: false,
      hostGlobal: true,
    });

    // Then
    expect(getAuthModalState().productLabel).toBeNull();
  });

  it('As the core, a Pairing without a deeplink yet shows the spinner', () => {
    // Given
    const { auth } = start();

    // When
    auth.set({ ...pairing, deeplink: '' });

    // Then
    expect(getAuthModalState().view).toEqual({ kind: 'spinner' });
  });

  it('As the core, Authenticating replaces the QR with progress and keeps the modal open', () => {
    // Given
    const { auth } = start();
    auth.set(pairing);

    // When
    auth.set({ tag: 'Authenticating' });

    // Then
    expect(getAuthModalState().view).toEqual({ kind: 'authenticating' });
    expect(getAuthModalState().open).toBe(true);
  });

  it('As the core, Connected closes the modal without cancelling', async () => {
    // Given
    const { controller, auth, calls, changes } = start();
    auth.set(pairing);

    // When
    auth.set({ tag: 'Connected', session: { connected: true } });
    controller.logout();

    // Then: the logout behind it ran, and no cancel came before it
    expect(getAuthModalState().open).toBe(false);
    await changes.until(() => calls.logouts === 1);
    expect(calls.cancels).toBe(0);
  });

  it('As the core, Disconnected never tears down an active pairing', () => {
    // Given
    const { auth } = start();
    auth.set({ tag: 'Connected', session: { connected: true } });
    auth.set(pairing);

    // When
    auth.set({ tag: 'Disconnected' });

    // Then
    expect(getAuthModalState().open).toBe(true);
    expect(getAuthModalState().view.kind).toBe('pairing');
  });

  it('As a new user, LoginFailed opens the host-global modal with retryable error copy', () => {
    // Given
    const { auth } = start();

    // When
    auth.set({
      tag: 'LoginFailed',
      kind: 'Other',
      reason: 'User declined the request',
    });

    // Then
    expect(getAuthModalState()).toEqual({
      open: true,
      productLabel: null,
      reason: null,
      view: {
        kind: 'error',
        message: 'User declined the request',
        retry: true,
        pending: false,
        title: 'Sign-in was declined',
        subtitle: 'The request was declined in Polkadot App. Start again and approve it on your phone.',
        detail: 'User declined the request',
      },
    });
  });

  it('As a new user whose account is still being set up, the failure is shown as a wait', () => {
    // Given
    const { auth } = start();

    // When
    auth.set({ tag: 'LoginFailed', kind: 'Other', reason: 'OriginPersonProviderError: not yet' });

    // Then
    expect(getAuthModalState().view).toMatchObject({
      kind: 'error',
      pending: true,
      title: 'Your account is still being set up',
    });
  });

  it('As a new user, an exhausted allowance is not offered a retry', () => {
    // Given
    const { auth } = start();

    // When
    auth.set({
      tag: 'LoginFailed',
      kind: 'NoFreeAllowanceSlots',
      reason: 'no slots',
    });

    // Then
    expect(getAuthModalState().view).toMatchObject({
      kind: 'error',
      retry: false,
      title: 'No Statement Store slots left',
      detail: 'no slots',
    });
  });

  it('As a new user, an account still being set up hides the raw reason', () => {
    // Given
    const { auth } = start();

    // When
    auth.set({
      tag: 'LoginFailed',
      kind: 'Other',
      reason: 'OriginPersonProviderError',
    });

    // Then
    expect(getAuthModalState().view).toMatchObject({
      kind: 'error',
      message: 'OriginPersonProviderError',
      retry: true,
      title: 'Your account is still being set up',
      detail: undefined,
    });
  });
});

describe('auth controller on the page stores', () => {
  afterEach(() => {
    resetAllStoresForTests();
  });

  describe('auth controller: the topbar sign-in', () => {
    it('As a dotli integrator, the host opens host-global login from the topbar even when a product is loaded', async () => {
      // Given
      const logins: (string | undefined)[] = [];
      const { promise: asked, resolve: loginAsked } = Promise.withResolvers<undefined>();
      const commands: AuthCommands = {
        login: reason => {
          logins.push(reason);
          loginAsked(undefined);
          return Promise.resolve();
        },
        logout: () => Promise.resolve(),
        cancelLogin: () => undefined,
      };
      initAuthController({
        coordinator: createBlockingModalCoordinator(),
        commands: () => Promise.resolve(commands),
      });
      setAuthState({ tag: 'Disconnected' });
      setProductLoaded('localhost:3000', 'localhost:3000');

      // When
      startLogin();
      await asked;

      // Then
      expect(getAuthModalState().productLabel).toBeNull();
      expect(logins).toEqual([undefined]);
    });

    it('As a dotli integrator, a failed login while a product is loaded keeps the host-global retry view', () => {
      // Given
      initAuthController({
        coordinator: createBlockingModalCoordinator(),
        commands: () =>
          Promise.resolve({
            login: () => Promise.resolve(),
            logout: () => Promise.resolve(),
            cancelLogin: () => undefined,
          }),
      });
      setAuthState({ tag: 'Disconnected' });
      setProductLoaded('localhost:3000', 'localhost:3000');

      // When
      setAuthState({ tag: 'LoginFailed', kind: 'Other', reason: 'Host failure' });

      // Then
      expect(getAuthModalState()).toMatchObject({
        open: true,
        productLabel: null,
        view: { kind: 'error', retry: true },
      });
    });
  });

  describe('auth error copy', () => {
    it('As a new user, a failure worth retrying keeps its raw reason and the retry', () => {
      // When
      const copy = friendlyAuthError('transport closed before the wallet answered');

      // Then
      expect(copy.title).toBe('Connection to Polkadot App was lost');
      expect(copy.detail).toBe('transport closed before the wallet answered');
      expect(copy.retryable).not.toBe(false);
    });

    it('As a new user, a rejected statement-store transaction is explained, with the raw reason', () => {
      // When
      const copy = friendlyAuthError('submit RPC error: Invalid Transaction');

      // Then
      expect(copy.title).toBe('Statement Store transaction rejected');
      expect(copy.detail).toBe('submit RPC error: Invalid Transaction');
      expect(copy.retryable).not.toBe(false);
    });

    it('As a new user, I am told when I declined the login on my phone', () => {
      // When
      const copy = friendlyAuthError('Login request denied');

      // Then
      expect(copy.title).toBe('Sign-in was declined');
      expect(copy.retryable).not.toBe(false);
    });

    it('As a new user, I am told when Polkadot App did not answer in time', () => {
      // When
      const copy = friendlyAuthError('runtime call timed out');

      // Then
      expect(copy.title).toBe('Sign-in timed out');
      expect(copy.retryable).not.toBe(false);
    });

    it('As a new user, I am not offered a retry when this page cannot log in at all', () => {
      // When
      const copy = friendlyAuthError('Login is not supported by this host');

      // Then
      expect(copy.title).toBe('Sign-in is not available here');
      expect(copy.retryable).toBe(false);
    });

    it('As a new user, a login runtime that fails to load reads as a page problem rather than a phone problem', () => {
      // When
      const copy = friendlyAuthError('worker init failed: undefined');

      // Then
      expect(copy.title).toBe('The sign-in service did not start');
      expect(copy.retryable).not.toBe(false);
    });

    it('As a new user, an unknown failure still reads as a login problem with the raw reason kept for bug reports', () => {
      // When
      const copy = friendlyAuthError('Host failure');

      // Then
      expect(copy).toEqual({
        title: 'Sign-in did not complete',
        subtitle:
          'Something interrupted the connection to Polkadot App. Try again, and make sure the app is installed and up to date.',
        detail: 'Host failure',
      });
    });
  });
});
