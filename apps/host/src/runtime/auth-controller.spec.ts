// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { withActiveTld } from '@dotli/config';
import { bindCaptureSink, type CaptureContext } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import type { AuthCommands, LoginOutcome } from './core-login.js';
import {
  createAuthController,
  disableAuthModal,
  initAuthController,
  startLogin,
  type AuthController,
  type InPagePhrase,
} from './auth-controller.js';
import {
  createBlockingModalCoordinator,
  type BlockingModalCoordinator,
  type BlockingModalScope,
  type HoldSlot,
} from './blocking-modal-queue.js';
import type { DotliAuthState } from './session/auth-state.js';
import { authModalStore, resetAuthModal, type AuthModalState } from '../state/auth-modal.js';
import { setAuthState } from './state/auth.js';
import { createSyncStore, deferred, type SyncStore } from '@dotli/shared';
import { nth, resetAllStoresForTests } from '@dotli/shared/testing';
import { setProductLoaded } from './state/product.js';
import { createChanges, type Changes } from '../testing/changes.js';
import type { SessionResult, SignInIntent } from './session-handoff/messages.js';
import type { PageCancelReason, SessionHandoff, SignInOutcome } from './session-handoff/opener.js';
import type { WalletMode } from './state/wallet-mode.js';
import type { WalletSwitchOutcome } from './wallet-switch.js';

/** What a fake login answers, which the controller does not read. */
const LOGIN_CANCELLED: LoginOutcome = { kind: 'cancelled' };

const CLOSED_MODAL: AuthModalState = { open: false, productLabel: null, reason: null, view: { kind: 'spinner' } };
const getAuthModalState = authModalStore.get;

type Started = {
  controller: AuthController;
  auth: SyncStore<DotliAuthState>;
  coordinator: BlockingModalCoordinator;
  /** What the controller asked of the bridge chunk's commands. */
  calls: {
    logins: (string | undefined)[];
    logouts: number;
    cancels: number;
  };
  /** Notified at each command asked and each change of the auth modal. */
  changes: Changes;
};

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  resetAuthModal();
});

/** Pages without the sign-in window never write a result. */
const noResult = (): Promise<never> => Promise.reject(new Error('This page has no sign-in window'));

/** A test that asks for no phrase loads no phrase import. */
const noPhrase = (): Promise<never> => Promise.reject(new Error('No phrase import in this test'));

const PHRASE = 'twelve good words';
const ENTROPY = new Uint8Array(16).fill(7);

/** The phrase import of a page that pairs in place, which knows only `PHRASE` and answers saves with `outcome`. */
function fakePhrase(outcome: WalletSwitchOutcome = 'reloading') {
  const used: Uint8Array[] = [];
  const phrase: InPagePhrase = {
    toEntropy: candidate => (candidate === PHRASE ? ENTROPY : null),
    useLocalWallet: entropy => {
      used.push(entropy);
      return Promise.resolve(outcome);
    },
  };
  return { phrase, used };
}

/** A controller over its own auth store, whose commands only record what they are asked. */
function start(
  options: {
    coordinator?: BlockingModalCoordinator;
    commands?: () => Promise<AuthCommands>;
    handoff?: SessionHandoff | null;
    applyResult?: (result: SessionResult) => Promise<'applied' | 'reloading'>;
    walletMode?: WalletMode;
    inPagePhrase?: () => Promise<InPagePhrase>;
    /** Whether a sign-in made elsewhere waits, as session state says. */
    elsewhere?: () => boolean;
  } = {},
): Started {
  const auth = createSyncStore<DotliAuthState>('auth-test', { tag: 'Restoring' }, { equals: () => false });
  const calls = {
    logins: [] as (string | undefined)[],
    logouts: 0,
    cancels: 0,
  };
  const changes = createChanges();
  disposers.push(authModalStore.subscribe(changes.notify));
  const commands: AuthCommands = {
    login: reason => {
      calls.logins.push(reason);
      changes.notify();
      return Promise.resolve(LOGIN_CANCELLED);
    },
    logout: () => {
      calls.logouts += 1;
      changes.notify();
      return Promise.resolve({ phone: 'told' as const });
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
    handoff: options.handoff ?? null,
    applyResult: options.applyResult ?? noResult,
    walletMode: () => options.walletMode ?? 'app',
    inPagePhrase: options.inPagePhrase ?? noPhrase,
    elsewhere: options.elsewhere ?? (() => false),
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
        enqueue<T>(task: (signal: AbortSignal, hold: HoldSlot) => Promise<T> | T): Promise<T> {
          return new Promise<T>(resolve => {
            tasks.push({
              run: async () => {
                resolve(await task(signal, () => undefined));
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
      logout: () => Promise.resolve({ phone: 'told' as const }),
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

  it('As the account popover, Sign out asks the core to log out', async () => {
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
      handoff: null,
      applyResult: noResult,
      inPagePhrase: noPhrase,
      coordinator: createBlockingModalCoordinator(),
      commands: () =>
        Promise.resolve({
          login: () => Promise.resolve(LOGIN_CANCELLED),
          logout: () => Promise.resolve({ phone: 'told' as const }),
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

type FakeHandoff = {
  readonly signIns: SignInIntent[];
  readonly signOuts: { notified: boolean }[];
  focuses: number;
  /** Why each open round was ended by the page. */
  readonly cancels: PageCancelReason[];
  /** Ends the open round with `outcome`, on behalf of the window or the user. */
  end(outcome: SignInOutcome): void;
} & SessionHandoff;

/** A handoff whose rounds end when the test says, recording what the page asked of it. */
function fakeHandoff(): FakeHandoff {
  let round: ReturnType<typeof deferred<SignInOutcome>> | null = null;
  const handoff: FakeHandoff = {
    signIns: [],
    signOuts: [],
    focuses: 0,
    cancels: [],
    signIn(intent) {
      handoff.signIns.push(intent);
      round ??= deferred<SignInOutcome>();
      return round.promise;
    },
    signOut(options) {
      handoff.signOuts.push(options);
    },
    signOutRead: () => Promise.resolve(),
    focus() {
      handoff.focuses += 1;
    },
    // As the real one, only an open round counts.
    cancel(reason) {
      if (round === null) {
        return;
      }
      handoff.cancels.push(reason);
      handoff.end({ kind: 'cancelled' });
    },
    end(outcome) {
      const open = round;
      round = null;
      open?.resolve(outcome);
    },
  };
  return handoff;
}

const RESULT: SessionResult = { session: { blob: '0xaa', uiState: null }, localWallet: null };
const SIGNED_IN: DotliAuthState = { tag: 'Connected', session: { connected: true } };

/** A page whose sign-in goes through the window, signed out, with the waiting view of a first Sign in on show. */
function startWindowRound(options: Parameters<typeof start>[0] = {}): Started & { handoff: FakeHandoff } {
  const handoff = fakeHandoff();
  const started = start({ ...options, handoff });
  started.auth.set({ tag: 'Disconnected' });
  started.controller.startLogin();
  return { ...started, handoff };
}

/** Writes of the window's result the test settles, each one recorded as asked. */
function heldResults(): {
  applyResult: (result: SessionResult) => Promise<'applied' | 'reloading'>;
  asked: Promise<SessionResult>;
  written: ReturnType<typeof deferred<'applied' | 'reloading'>>;
  results: SessionResult[];
} {
  const results: SessionResult[] = [];
  const asked = deferred<SessionResult>();
  const written = deferred<'applied' | 'reloading'>();
  return {
    applyResult: result => {
      results.push(result);
      asked.resolve(result);
      return written.promise;
    },
    asked: asked.promise,
    written,
    results,
  };
}

describe('auth controller: the sign-in window', () => {
  it('As a debug panel user, I import a phrase and the window opens at its phrase view while I wait', () => {
    // Given a signed-out page with a sign-in window
    const handoff = fakeHandoff();
    const { controller, auth, calls } = start({ handoff });
    auth.set({ tag: 'Disconnected' });

    // When the debug panel imports a phrase
    controller.importPhrase();

    // Then: opened in the click's own turn, and the core is not asked to pair
    expect(handoff.signIns).toEqual(['phrase']);
    expect(getAuthModalState()).toEqual({ open: true, productLabel: null, reason: null, view: { kind: 'window' } });
    expect(calls.logins).toEqual([]);
  });

  it('As a debug panel user with a local wallet, I replace it and the window opens', () => {
    // Given a signed-in page in local mode with a sign-in window
    const handoff = fakeHandoff();
    const { controller, auth } = start({ handoff, walletMode: 'local' });
    auth.set(SIGNED_IN);

    // When the debug panel imports a phrase
    controller.importPhrase();

    // Then the phrase window opens
    expect(handoff.signIns).toEqual(['phrase']);
  });

  it('As a signed-in debug panel user typing a phrase in the sign-in window, I see my session reported again and the window stays open', () => {
    // Given a signed-in page in local mode whose phrase window is open
    const handoff = fakeHandoff();
    const { controller, auth } = start({ handoff, walletMode: 'local' });
    auth.set(SIGNED_IN);
    controller.importPhrase();

    // When: the core reports the session it already had
    auth.set(SIGNED_IN);

    // Then the round is not cancelled and the waiting view stays
    expect(handoff.cancels).toEqual([]);
    expect(getAuthModalState()).toMatchObject({ open: true, view: { kind: 'window' } });
  });

  it('As a debug panel user on a page that pairs in place, I import a phrase and the modal opens at its phrase view', async () => {
    // Given a signed-out page that pairs in place
    const { phrase } = fakePhrase();
    const { controller, auth, calls, changes } = start({ inPagePhrase: () => Promise.resolve(phrase) });
    auth.set({ tag: 'Disconnected' });

    // When the debug panel imports a phrase
    controller.importPhrase();

    // Then the view shows once its phrase check loaded, and no pairing starts
    await changes.until(() => getAuthModalState().view.kind === 'phrase');
    expect(getAuthModalState().open).toBe(true);
    expect(controller.isValidPhrase(PHRASE)).toBe(true);
    expect(controller.isValidPhrase('not a phrase')).toBe(false);
    expect(calls.logins).toEqual([]);
  });

  it('As a debug panel user on a page that pairs in place, I import my phrase and it is used for every app', async () => {
    // Given the modal open at its phrase view
    const { phrase, used } = fakePhrase();
    const { controller, changes } = start({ inPagePhrase: () => Promise.resolve(phrase) });
    controller.importPhrase();
    await changes.until(() => getAuthModalState().view.kind === 'phrase');

    // When a valid phrase is imported
    await controller.importPhraseInPage(PHRASE);

    // Then its entropy is used as the local wallet
    expect(used).toEqual([ENTROPY]);
  });

  it('As a debug panel user on a page that pairs in place, I enter a phrase that is not one and nothing is saved', async () => {
    // Given the modal open at its phrase view
    const { phrase, used } = fakePhrase();
    const { controller, changes } = start({ inPagePhrase: () => Promise.resolve(phrase) });
    controller.importPhrase();
    await changes.until(() => getAuthModalState().view.kind === 'phrase');

    const exceptions: unknown[] = [];
    disposers.push(
      bindCaptureSink({
        exception: error => {
          exceptions.push(error);
        },
        expected: () => undefined,
      }),
    );

    // When a phrase that is not one is imported
    const imported = controller.importPhraseInPage('not a phrase');

    // Then the form says it, and what the user typed is not reported
    await expect(imported).rejects.toThrow('Not a valid recovery phrase');
    expect(used).toEqual([]);
    expect(exceptions).toEqual([]);
  });

  it('As a debug panel user, I import a phrase before its module loaded and the failure is reported', async () => {
    // Given a phrase import that has not loaded
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const exceptions: [unknown, CaptureContext][] = [];
    disposers.push(
      bindCaptureSink({
        exception: (error, context) => {
          exceptions.push([error, context]);
        },
        expected: () => undefined,
      }),
    );
    const { controller } = start();

    // When a phrase is imported before the module loaded
    const imported = controller.importPhraseInPage(PHRASE);

    // Then the import rejects and the load failure is reported and counted
    await expect(imported).rejects.toThrow('The recovery phrase import was not loaded');
    expect(exceptions).toEqual([
      [expect.any(Error), { flow: 'wallet', step: 'local_wallet', tags: { reason: 'phrase-load' } }],
    ]);
    expect(metrics.counted('wallet.local_activate')).toEqual([{ outcome: 'error', reason: 'phrase-load' }]);
  });

  it('As a debug panel user on a page that pairs in place, I import a phrase whose wallet could not be saved and the form says so', async () => {
    // Given the modal at its phrase view over a wallet save that fails
    const { phrase } = fakePhrase('failed');
    const { controller, changes } = start({ inPagePhrase: () => Promise.resolve(phrase) });
    controller.importPhrase();
    await changes.until(() => getAuthModalState().view.kind === 'phrase');

    // When a valid phrase is imported
    const imported = controller.importPhraseInPage(PHRASE);

    // Then the form says it, and the modal stays on the phrase view
    await expect(imported).rejects.toThrow('The recovery phrase wallet could not be saved');
    expect(getAuthModalState().view.kind).toBe('phrase');
  });

  it("As a debug panel user typing a phrase, I keep my phrase view on show while a product's pairing runs or fails", async () => {
    // Given a signed-out page whose modal shows the phrase view
    const { phrase } = fakePhrase();
    const { controller, auth, changes } = start({ inPagePhrase: () => Promise.resolve(phrase) });
    auth.set({ tag: 'Disconnected' });
    controller.importPhrase();
    await changes.until(() => getAuthModalState().view.kind === 'phrase');

    // When the core pairs for a product, then fails
    auth.set({ tag: 'Pairing', deeplink: 'polkadotapp://pair?handshake=test', label: 'x' });
    auth.set({ tag: 'Authenticating' });
    auth.set({ tag: 'LoginFailed', kind: 'Other', reason: 'timed out' });

    // Then the phrase view stays on show
    expect(getAuthModalState()).toMatchObject({ open: true, view: { kind: 'phrase' } });
  });

  it('As a debug panel user, I close the modal while the phrase check loads and it stays closed', async () => {
    // Given a phrase check that has not loaded yet
    const { phrase } = fakePhrase();
    const loaded = deferred<InPagePhrase>();
    const { controller } = start({ inPagePhrase: () => loaded.promise });
    controller.importPhrase();

    // When the modal closes and then the check loads
    controller.closeAuthModal({ skipTruapiCancel: true });
    loaded.resolve(phrase);
    // The controller heard the load before this test, as it asked first.
    await loaded.promise;

    // Then the modal stays closed
    expect(getAuthModalState()).toEqual(CLOSED_MODAL);
  });

  it('As a debug panel user whose phrase check could not load, I see the failure, and Retry opens the phrase view', async () => {
    // Given a phrase check whose first load fails
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const { phrase } = fakePhrase();
    let loads = 0;
    const { controller, calls, changes } = start({
      inPagePhrase: () => (++loads === 1 ? Promise.reject(new Error('chunk failed')) : Promise.resolve(phrase)),
    });

    // When the debug panel imports a phrase
    controller.importPhrase();

    // Then the failure shows and the missed chunk is counted
    await changes.until(() => getAuthModalState().view.kind === 'error');
    expect(metrics.counted('lazy_chunk.load')).toEqual([{ outcome: 'error', reason: 'phrase_import' }]);

    // When Retry is pressed
    controller.retryLogin();

    // Then the phrase view opens, and no pairing starts
    await changes.until(() => getAuthModalState().view.kind === 'phrase');
    expect(calls.logins).toEqual([]);
  });

  it('As a debug panel user, I import again while the sign-in window is open and it comes to the front', () => {
    // Given a phrase window already open
    const handoff = fakeHandoff();
    const { controller, auth } = start({ handoff });
    auth.set({ tag: 'Disconnected' });
    controller.importPhrase();

    // When the debug panel imports again
    controller.importPhrase();

    // Then no second window opens and the open one is focused
    expect(handoff.signIns).toEqual(['phrase']);
    expect(handoff.focuses).toBe(1);
  });

  it('As a debug panel user, I import while the saved session cannot be reached and no window opens', () => {
    // Given a page whose saved session cannot be reached
    const handoff = fakeHandoff();
    const { controller, auth } = start({ handoff });
    auth.set({ tag: 'Unreachable' });

    // When the debug panel imports a phrase
    controller.importPhrase();

    // Then no window opens and the modal stays closed
    expect(handoff.signIns).toEqual([]);
    expect(getAuthModalState().open).toBe(false);
  });

  it('As a user on a product, I press Sign in and the window opens with the waiting view', () => {
    // Given a signed-out page with a sign-in window
    const handoff = fakeHandoff();
    const { controller, auth, calls } = start({ handoff });
    auth.set({ tag: 'Disconnected' });

    // When the user presses Sign in
    controller.startLogin();

    // Then: opened in the click's own turn, and the core is not asked to pair
    expect(handoff.signIns).toEqual(['signin']);
    expect(getAuthModalState()).toEqual({ open: true, productLabel: null, reason: null, view: { kind: 'window' } });
    expect(calls.logins).toEqual([]);
  });

  it('As a user, I press Sign in again while the window is open and that window comes to the front', () => {
    // Given a sign-in window round under way
    const { controller, handoff } = startWindowRound();

    // When the user presses Sign in again and then Focus
    controller.startLogin();
    controller.focusSignInWindow();

    // Then one window opened and it was focused each time
    expect(handoff.signIns).toEqual(['signin']);
    expect(handoff.focuses).toBe(2);
    expect(getAuthModalState().view).toEqual({ kind: 'window' });
  });

  it("As a user whose page shares the sign-in window's store, I see my sign-in early and the window stays open for its result, which names my account", async () => {
    // Given a window round whose result write is held
    const held = heldResults();
    const { auth, handoff, calls, changes } = startWindowRound({ applyResult: held.applyResult });

    // When: the window's own store write signs the page in before its result arrives
    auth.set(SIGNED_IN);

    // Then: the round and its window stay, so the result with the account still lands
    expect(handoff.cancels).toEqual([]);
    expect(getAuthModalState().view).toEqual({ kind: 'window' });
    expect(calls.cancels).toBe(0);

    // When the result arrives and is written
    handoff.end({ kind: 'result', result: RESULT });
    await expect(held.asked).resolves.toBe(RESULT);
    held.written.resolve('applied');

    // Then the modal closes
    await changes.until(() => !getAuthModalState().open);
    expect(getAuthModalState()).toEqual(CLOSED_MODAL);
  });

  it('As a user, I finish signing in through the window and its result is written into this page while the waiting view closes', async () => {
    // Given a window round whose result write is held
    const held = heldResults();
    const { controller, handoff, changes } = startWindowRound({ applyResult: held.applyResult });

    // When the result comes and the user presses Sign in meanwhile
    handoff.end({ kind: 'result', result: RESULT });
    await expect(held.asked).resolves.toBe(RESULT);
    controller.startLogin();

    // Then: the waiting view stays until the write is done, and Sign in meanwhile starts no second round
    expect(getAuthModalState().view).toEqual({ kind: 'window' });
    expect(handoff.signIns).toEqual(['signin']);
    held.written.resolve('applied');
    await changes.until(() => !getAuthModalState().open);
    expect(getAuthModalState()).toEqual(CLOSED_MODAL);
  });

  it('As a user, I press Cancel while the result is being written and no waiting view comes back', async () => {
    // Given: a result being written
    const held = heldResults();
    const { controller, handoff } = startWindowRound({ applyResult: held.applyResult });
    handoff.end({ kind: 'result', result: RESULT });
    await held.asked;
    // Registered after the controller's own wait on the write, so it settles after the controller saw it.
    const seen = held.written.promise.then(() => undefined);

    // When the user presses Cancel and the write then lands
    controller.closeAuthModal();
    held.written.resolve('applied');
    await seen;

    // Then the modal stays closed and the result was written once
    expect(getAuthModalState()).toEqual(CLOSED_MODAL);
    expect(held.results).toEqual([RESULT]);
  });

  it('As a user, I press Cancel on the waiting view and the window round ends', () => {
    // Given a sign-in window round under way
    const { controller, handoff } = startWindowRound();

    // When the user presses Cancel
    controller.closeAuthModal();

    // Then the page cancels the round and the modal closes
    expect(handoff.cancels).toEqual(['page']);
    expect(getAuthModalState()).toEqual(CLOSED_MODAL);
  });

  it('As a user who closed the sign-in window, I am back to signed out with no error', async () => {
    // Given a sign-in window round under way
    const { handoff, changes } = startWindowRound();

    // When the window is closed
    handoff.end({ kind: 'cancelled' });

    // Then the modal closes with no error
    await changes.until(() => !getAuthModalState().open);
    expect(getAuthModalState()).toEqual(CLOSED_MODAL);
  });

  it('As a user whose browser blocked the window, I see why and press Try again from a new click', async () => {
    // Given a sign-in window round under way
    const { controller, handoff, changes } = startWindowRound();

    // When the browser blocks the window and the user presses Try again
    handoff.end({ kind: 'blocked' });
    await changes.until(() => getAuthModalState().view.kind === 'blocked');
    controller.retryLogin();

    // Then a second window opens and the waiting view shows
    expect(handoff.signIns).toEqual(['signin', 'signin']);
    expect(getAuthModalState()).toMatchObject({ open: true, view: { kind: 'window' } });
  });

  it('As a signed-in debug panel user whose phrase window was blocked, I press Try again and the phrase window opens', async () => {
    // Given a signed-in page whose phrase window was blocked
    const handoff = fakeHandoff();
    const { controller, auth, changes } = start({ handoff, walletMode: 'local' });
    auth.set(SIGNED_IN);
    controller.importPhrase();
    handoff.end({ kind: 'blocked' });
    await changes.until(() => getAuthModalState().view.kind === 'blocked');

    // When the user presses Try again
    controller.retryLogin();

    // Then the phrase window opens again and the waiting view shows
    expect(handoff.signIns).toEqual(['phrase', 'phrase']);
    expect(getAuthModalState()).toMatchObject({ open: true, view: { kind: 'window' } });
  });

  it('As a debug panel user whose wallet could not be written here, I press Retry and the phrase window opens', async () => {
    // Given a phrase round whose result could not be written
    disposers.push(bindCaptureSink({ exception: () => undefined, expected: () => undefined }));
    const handoff = fakeHandoff();
    const { controller, auth, changes } = start({
      handoff,
      applyResult: () => Promise.reject(new Error('The local wallet from the sign-in window could not be saved')),
    });
    auth.set({ tag: 'Disconnected' });
    controller.importPhrase();
    handoff.end({ kind: 'result', result: RESULT });
    await changes.until(() => getAuthModalState().view.kind === 'error');

    // When the user presses Retry
    controller.retryLogin();

    // Then the phrase window opens again
    expect(handoff.signIns).toEqual(['phrase', 'phrase']);
  });

  it('As a user whose sign-in window was blocked, I close the modal and press Try again and a sign-in window opens', async () => {
    // Given: a blocked phrase round whose modal the user closed
    const handoff = fakeHandoff();
    const { controller, auth, changes } = start({ handoff });
    auth.set({ tag: 'Disconnected' });
    controller.importPhrase();
    handoff.end({ kind: 'blocked' });
    await changes.until(() => getAuthModalState().view.kind === 'blocked');
    controller.closeAuthModal();

    // When: a product's prompt later asks for the click
    controller.retryLogin();

    // Then a sign-in window opens after the blocked phrase window
    expect(handoff.signIns).toEqual(['phrase', 'signin']);
  });

  it('As a user on a page the window refuses, I am told sign-in is not available here', async () => {
    // Given a sign-in window round under way
    const { handoff, changes } = startWindowRound();

    // When the window refuses the page
    handoff.end({ kind: 'refused' });

    // Then the modal stays open on the refused view
    await changes.until(() => getAuthModalState().view.kind === 'refused');
    expect(getAuthModalState().open).toBe(true);
  });

  it('As a user whose sign-in could not be written here, I see the error with Retry and it is reported', async () => {
    // Given a window round whose result write fails
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const exceptions: [unknown, CaptureContext][] = [];
    disposers.push(
      bindCaptureSink({
        exception: (error, context) => {
          exceptions.push([error, context]);
        },
        expected: () => undefined,
      }),
    );
    const failure = new Error('The session from the sign-in window could not be stored');
    const { handoff, changes } = startWindowRound({ applyResult: () => Promise.reject(failure) });

    // When the result comes
    handoff.end({ kind: 'result', result: RESULT });

    // Then the error shows with Retry and the failure is reported and counted under the intent
    await changes.until(() => getAuthModalState().view.kind === 'error');
    expect(getAuthModalState()).toMatchObject({ open: true, view: { kind: 'error', retry: true } });
    expect(exceptions).toEqual([[failure, { flow: 'wallet', step: 'session_window', tags: { reason: 'signin' } }]]);
    expect(metrics.counted('session_window.apply')).toEqual([{ outcome: 'error', reason: 'signin' }]);
    expect(metrics.counted('session_window.round')).toEqual([]);
  });

  it('As an operator, I see a phrase window result the page could not write counted under the phrase intent', async () => {
    // Given a phrase round whose result the page's copy refuses
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    disposers.push(bindCaptureSink({ exception: () => undefined, expected: () => undefined }));
    const handoff = fakeHandoff();
    const { controller, auth, changes } = start({
      handoff,
      applyResult: () => Promise.reject(new Error('The local wallet from the sign-in window could not be saved')),
    });
    auth.set({ tag: 'Disconnected' });
    controller.importPhrase();

    // When the window's result comes
    handoff.end({ kind: 'result', result: RESULT });

    // Then the failure is counted under the phrase intent, not as a round
    await changes.until(() => getAuthModalState().view.kind === 'error');
    expect(metrics.counted('session_window.apply')).toEqual([{ outcome: 'error', reason: 'phrase' }]);
    expect(metrics.counted('session_window.round')).toEqual([]);
  });

  it("As a user, I get a product's login request and see Sign in to continue with nothing opened by itself", () => {
    // Given a signed-out page with a sign-in window
    const handoff = fakeHandoff();
    const { auth } = start({ handoff });

    // When a product asks for a login
    auth.set(pairing);

    // Then the prompt shows under the product's name and no window opens
    expect(getAuthModalState()).toEqual({
      open: true,
      productLabel: 'localhost:3000',
      reason: null,
      view: { kind: 'prompt', resume: false },
    });
    expect(handoff.signIns).toEqual([]);
  });

  it('As a user shown Sign in to continue, I see nothing change on screen when the core repeats its pairing', () => {
    // Given the prompt on show and every later modal write recorded
    const { auth } = start({ handoff: fakeHandoff() });
    auth.set({ ...pairing, deeplink: '' });
    const writes: AuthModalState[] = [];
    disposers.push(
      authModalStore.subscribe(() => {
        writes.push(getAuthModalState());
      }),
    );

    // When: the core reports the pairing again, now with its deeplink
    auth.set(pairing);

    // Then nothing was written and the prompt stays
    expect(writes).toEqual([]);
    expect(getAuthModalState().view).toEqual({ kind: 'prompt', resume: false });
  });

  it("As a user asked by a product, I press Sign in and the window opens under the product's name", () => {
    // Given a product's login request on show
    const handoff = fakeHandoff();
    const { controller, auth } = start({ handoff });
    auth.set(pairing);

    // When the user presses Sign in and the core repeats its pairing
    controller.startLogin();
    auth.set(pairing);

    // Then: the core's pairing updates leave the waiting view alone
    expect(handoff.signIns).toEqual(['signin']);
    expect(getAuthModalState()).toMatchObject({ open: true, productLabel: 'localhost:3000', view: { kind: 'window' } });
  });

  it('As a user whose sign-in waits elsewhere, I sign in and the window opens to resume it', () => {
    // Given a signed-out page whose sign-in made elsewhere waits
    const handoff = fakeHandoff();
    const { controller, auth } = start({ handoff, elsewhere: () => true });
    auth.set({ tag: 'Disconnected' });

    // When the user presses Sign in
    controller.startLogin();

    // Then the window opens to resume and the waiting view shows
    expect(handoff.signIns).toEqual(['resume']);
    expect(getAuthModalState()).toMatchObject({ open: true, view: { kind: 'window' } });
  });

  it("As a user whose sign-in waits elsewhere, I get a product's login request that offers to continue it and its button resumes", () => {
    // Given a product's login request while a sign-in made elsewhere waits
    const handoff = fakeHandoff();
    const { controller, auth } = start({ handoff, elsewhere: () => true });
    auth.set(pairing);

    // When the prompt is read and its button pressed
    const prompt = getAuthModalState().view;
    controller.retryLogin();

    // Then the prompt offers to continue and the window opens to resume
    expect(prompt).toEqual({ kind: 'prompt', resume: true });
    expect(handoff.signIns).toEqual(['resume']);
  });

  it('As a user whose resume window was blocked, I press Try again and it asks to resume again', async () => {
    // Given a resume round under way
    const { controller, handoff, changes } = startWindowRound({ elsewhere: () => true });

    // When the browser blocks the window and the user presses Try again
    handoff.end({ kind: 'blocked' });
    await changes.until(() => getAuthModalState().view.kind === 'blocked');
    controller.retryLogin();

    // Then the window opens to resume again
    expect(handoff.signIns).toEqual(['resume', 'resume']);
  });

  it('As a user whose waiting sign-in went before I pressed Try again, I press it and sign in as usual', async () => {
    // Given a resume round whose window was blocked
    let elsewhere = true;
    const { controller, handoff, changes } = startWindowRound({ elsewhere: () => elsewhere });
    handoff.end({ kind: 'blocked' });
    await changes.until(() => getAuthModalState().view.kind === 'blocked');

    // When the waiting sign-in goes and the user presses Try again
    elsewhere = false;
    controller.retryLogin();

    // Then the second window opens to sign in
    expect(handoff.signIns).toEqual(['resume', 'signin']);
  });

  it('As a user in paired mode, I sign out and the window opens with notified', async () => {
    // Given a page in paired mode with a sign-in window
    const handoff = fakeHandoff();
    const { controller, calls, changes } = start({ handoff, walletMode: 'app' });

    // When the user signs out
    controller.logout();

    // Then: the window opens in the click's own turn, before the core is asked
    expect(handoff.signOuts).toEqual([{ notified: true }]);
    expect(calls.logouts).toBe(0);
    await changes.until(() => calls.logouts === 1);
  });

  it('As a signed-in user on a product page, I sign out and the window opens before the bridge answers', () => {
    // Given a bridge chunk that has not loaded
    const handoff = fakeHandoff();
    const { controller } = start({ handoff, commands: () => new Promise<AuthCommands>(() => undefined) });

    // When the user signs out
    controller.logout();

    // Then the sign-out window opened at once, marked notified
    expect(handoff.signOuts).toEqual([{ notified: true }]);
  });

  it('As a user in local mode, I sign out and the window opens without notified, then the page logs out', async () => {
    // Given a page in local mode with a sign-in window
    const handoff = fakeHandoff();
    const { controller, calls, changes } = start({ handoff, walletMode: 'local' });

    // When the user signs out
    controller.logout();

    // Then: the window, which tells the phone, opens unnotified, and the page logs out
    expect(handoff.signOuts).toEqual([{ notified: false }]);
    await changes.until(() => calls.logouts === 1);
  });

  it('As a user in local mode on a preview its preview host frames, I sign out in place and the paired copy stays', async () => {
    // Given: a page with no sign-in window, so nothing would tell the phone
    const { controller, calls, changes } = start({ handoff: null, walletMode: 'local' });

    // When the user signs out
    controller.logout();

    // Then the page logs out with no window
    await changes.until(() => calls.logouts === 1);
  });

  it('As a user whose sign-in modal broke, I still sign in through the window and the modal stays closed', async () => {
    // Given: a broken modal island
    const exceptions: unknown[] = [];
    disposers.push(
      bindCaptureSink({
        exception: error => {
          exceptions.push(error);
        },
        expected: () => undefined,
      }),
    );
    const failure = new Error('The session from the sign-in window could not be stored');
    const handoff = fakeHandoff();
    const { controller, auth, calls, changes } = start({ handoff, applyResult: () => Promise.reject(failure) });
    controller.disableAuthModal();
    auth.set({ tag: 'Disconnected' });
    controller.startLogin();

    // When: a blocked round, then a retry whose result cannot be written
    handoff.end({ kind: 'blocked' });
    await changes.until(() => getAuthModalState().view.kind === 'blocked');
    controller.startLogin();
    handoff.end({ kind: 'result', result: RESULT });

    // Then: both windows opened and the failure is reported, while the modal never opened and each of its three opens
    // (two sign-ins and the failure) cancelled the core's login instead
    await changes.until(() => getAuthModalState().view.kind === 'error');
    expect(handoff.signIns).toEqual(['signin', 'signin']);
    expect(exceptions).toEqual([failure]);
    expect(getAuthModalState().open).toBe(false);
    await changes.until(() => calls.cancels === 3);
  });

  it('As a user whose sign-in modal breaks while the window is open, I still sign in through the window and the modal never opens', async () => {
    // Given: a window round on show
    const held = heldResults();
    const { controller, handoff, calls, changes } = startWindowRound({ applyResult: held.applyResult });

    // When: the modal island breaks, then the window sends its result
    controller.disableAuthModal();
    handoff.end({ kind: 'result', result: RESULT });

    // Then: the round was not cancelled, its result is written, and the core's login was left alone
    await expect(held.asked).resolves.toBe(RESULT);
    expect(handoff.cancels).toEqual([]);
    expect(getAuthModalState().open).toBe(false);
    held.written.resolve('applied');
    await changes.until(() => held.results.length === 1);
    expect(calls.cancels).toBe(0);
  });

  it('As a user whose sign-in modal broke while the window is open, I close the window and the login still ends', async () => {
    // Given a window round under way with the modal broken
    const { controller, handoff, calls, changes } = startWindowRound();
    controller.disableAuthModal();

    // When the window is closed
    handoff.end({ kind: 'cancelled' });

    // Then: a product's login waiting on the core is answered
    await changes.until(() => calls.cancels === 1);
    expect(handoff.cancels).toEqual([]);
  });

  it('As a user on a preview its preview host frames, I sign in in place and see the pairing in the modal', async () => {
    // Given: a page with no sign-in window
    const { controller, auth, calls, changes } = start({ handoff: null });
    auth.set({ tag: 'Disconnected' });

    // When the user presses Sign in and the core pairs
    controller.startLogin();
    auth.set(pairing);

    // Then the core logs in and the modal shows the pairing
    await changes.until(() => calls.logins.length === 1);
    expect(getAuthModalState().view).toEqual({ kind: 'pairing', payload: pairing.deeplink });
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
          return Promise.resolve(LOGIN_CANCELLED);
        },
        logout: () => Promise.resolve({ phone: 'told' as const }),
        cancelLogin: () => undefined,
      };
      initAuthController({
        handoff: null,
        applyResult: noResult,
        inPagePhrase: noPhrase,
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
        handoff: null,
        applyResult: noResult,
        inPagePhrase: noPhrase,
        coordinator: createBlockingModalCoordinator(),
        commands: () =>
          Promise.resolve({
            login: () => Promise.resolve(LOGIN_CANCELLED),
            logout: () => Promise.resolve({ phone: 'told' as const }),
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
});
