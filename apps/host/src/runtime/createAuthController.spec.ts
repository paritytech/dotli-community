// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { asProductId } from '@parity/truapi';
import { withActiveTld } from '@dotli/config';
import { bindCaptureSink, type CaptureContext } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import type { LoginOutcome } from './createAuthCommands.js';
import type { AuthCommands } from './runAuthCommand.js';
import { authControl, createAuthControlSlot } from './authControl.js';
import { createAuthController } from './createAuthController.js';
import { createBlockingModalCoordinator, type BlockingModalCoordinator } from './createBlockingModalCoordinator.js';
import type { DotliAuthState } from './session/types.js';
import { authModalState, type AuthModalState } from '../state/authModalState.js';
import { authState } from './state/authState.js';
import { createDeferred, createListenerSet } from '@dotli/shared';
import { atom } from 'nanostores';
import { catchError, nth, recordLog, resetAllStoresForTests } from '@dotli/shared/testing';
import { productState } from './state/productState.js';
import { createChanges, type Changes } from '../testing/changes.js';
import { recordNotified } from '../testing/recordNotified.js';
import type { SignInIntent } from './sessionHandoff/parseWindowRequest.js';
import type { SessionResult } from './sessionHandoff/parseSessionResult.js';
import type { PageCancelReason, SessionHandoff, SignInOutcome } from './sessionHandoff/createSessionHandoff.js';
import type { WalletSwitchOutcome } from './createWalletSwitch.js';

type AuthControlSlot = ReturnType<typeof createAuthControlSlot>;
type ControllerParams = Parameters<typeof createAuthController>[0];
type AuthBridge = Awaited<ReturnType<ControllerParams['bridge']>>;
type PhraseCheck = Awaited<ReturnType<ControllerParams['loadRecoveryPhrase']>>;

/** What the controller asked of the bridge chunk's commands. */
type Calls = {
  /** The reason of each login asked for, in order. */
  logins: (string | undefined)[];
  /** How many logouts were asked for. */
  logouts: number;
  /** How many cancels were asked for. */
  cancels: number;
};

type StartControllerParams = {
  /** The coordinator the modal leases come from, a fresh one by default. */
  coordinator?: BlockingModalCoordinator;
  /**
   * Loads the bridge chunk's commands, ones that only record what they are asked by default. A rejection fails the
   * whole bridge load.
   */
  commands?: () => Promise<AuthCommands>;
  /** The sign-in window's session handoff, none by default. */
  handoff?: SessionHandoff | null;
  /** Applies the session result a sign-in window sends, rejecting by default. */
  applyResult?: (result: SessionResult) => Promise<'applied' | 'reloading'>;
  /** Whether the page runs on a local wallet, paired by default. */
  local?: boolean;
  /** Loads the phrase check of a page that pairs in place, rejecting by default. */
  loadRecoveryPhrase?: ControllerParams['loadRecoveryPhrase'];
  /** The bridge's wallet switch, whose phrase wallet save rejects by default. */
  walletSwitch?: AuthBridge['walletSwitch'];
  /** Whether a sign-in made elsewhere waits, as session state says. */
  elsewhere?: () => boolean;
  /** Reads the saved session again, by default resolving with the auth state left as it was. */
  rereadSession?: () => Promise<void>;
};

type CreateFakePhraseParams = {
  /** What a save of the phrase's wallet answers, a reload by default. */
  outcome?: WalletSwitchOutcome;
};

type RecordCommandsParams = {
  /** Notified at each command asked. */
  changes: Changes;
};

/** What a fake login answers, which the controller does not read. */
const LOGIN_CANCELLED: LoginOutcome = { kind: 'cancelled' };

const CLOSED_MODAL: AuthModalState = { open: false, productLabel: null, reason: null, view: { kind: 'spinner' } };
function getAuthModalState(): AuthModalState {
  return authModalState.store.get();
}

const PHRASE = 'twelve good words';
const ENTROPY = new Uint8Array(16).fill(7);

const PAIRING = {
  tag: 'Pairing',
  deeplink: 'polkadotapp://pair?handshake=test',
  label: 'localhost:3000',
} as const;

const RESULT: SessionResult = { session: { blob: '0xaa', uiState: null }, localWallet: null };
const SIGNED_IN: DotliAuthState = { tag: 'Connected', session: { connected: true } };

afterEach(() => {
  authModalState.reset();
});

/** A test that saves no phrase wallet switches to none. */
const NO_WALLET_SWITCH: AuthBridge['walletSwitch'] = { useLocalWallet: rejectNoPhrase };

/** Pages without the sign-in window never write a result. */
function rejectNoResult(): Promise<never> {
  return Promise.reject(new Error('This page has no sign-in window'));
}

/** A test that asks for no phrase loads no phrase import. */
function rejectNoPhrase(): Promise<never> {
  return Promise.reject(new Error('No phrase import in this test'));
}

/**
 * Resolves after one macrotask turn, so every promise reaction queued now, and every one those queue in turn, has run.
 * It waits for no time.
 */
function untilPromisesSettled(): Promise<void> {
  return new Promise(resolve => {
    setImmediate(resolve);
  });
}

/** Every exception the capture sink is told of, with its context, while this test runs. */
function captureExceptions(): [unknown, CaptureContext][] {
  const exceptions: [unknown, CaptureContext][] = [];
  onTestFinished(
    bindCaptureSink({
      exception: (error, context) => {
        exceptions.push([error, context]);
      },
      expected: () => undefined,
    }),
  );
  return exceptions;
}

/**
 * The phrase check of a page that pairs in place, which knows only `PHRASE`, and the wallet switch it saves through,
 * which answers saves with `outcome`.
 */
function createFakePhrase({ outcome = 'reloading' }: CreateFakePhraseParams = {}) {
  const used: Uint8Array[] = [];
  const phrase: PhraseCheck = {
    toEntropy: candidate => (candidate === PHRASE ? ENTROPY : null),
  };
  const walletSwitch: AuthBridge['walletSwitch'] = {
    useLocalWallet(entropy) {
      used.push(entropy);
      return Promise.resolve(outcome);
    },
  };
  return { phrase, walletSwitch, used };
}

/** A controller over its own auth store and steps, whose commands only record what they are asked. */
function startController({
  coordinator = createBlockingModalCoordinator(),
  commands,
  handoff = null,
  applyResult = rejectNoResult,
  local = false,
  loadRecoveryPhrase = rejectNoPhrase,
  walletSwitch = NO_WALLET_SWITCH,
  elsewhere = () => false,
  rereadSession = () => Promise.resolve(),
}: StartControllerParams = {}) {
  const auth = atom<DotliAuthState>({ tag: 'Restoring' });
  const steps = createListenerSet<DotliAuthState>({
    onListenerError: error => {
      throw new Error('An auth step listener threw', { cause: error });
    },
  });

  // A repeated step reaches the steps, though the store drops it as equal.
  function setAuthStep(next: DotliAuthState): void {
    auth.set(next);
    steps.emit(next);
  }

  const changes = createChanges();
  onTestFinished(authModalState.store.listen(changes.notify));
  const recorded = recordCommands({ changes });
  const loadCommands = commands ?? (() => Promise.resolve(recorded.commands));
  const controller = createAuthController({
    coordinator,
    bridge: async () => ({
      authCommands: await loadCommands(),
      applyWindowResult: applyResult,
      rereadSession,
      walletSwitch,
    }),
    auth,
    subscribeAuthSteps: steps.subscribe,
    handoff,
    isLocalWallet: () => local,
    loadRecoveryPhrase,
    elsewhere,
  });
  onTestFinished(() => {
    controller.dispose();
  });
  return {
    /** The controller under test. */
    controller,
    /** The auth state it follows, which the test sets as the core would. */
    auth: { set: setAuthStep },
    /** The coordinator its modal leases come from. */
    coordinator,
    /** What the controller asked of the bridge chunk's commands. */
    calls: recorded.calls,
    /** Notified at each command asked and each change of the auth modal. */
    changes,
  };
}

/** Commands that only record what they are asked, notifying `changes` at each. */
function recordCommands({ changes }: RecordCommandsParams): { commands: AuthCommands; calls: Calls } {
  const calls: Calls = { logins: [], logouts: 0, cancels: 0 };
  const commands: AuthCommands = {
    login({ reason } = {}) {
      calls.logins.push(reason);
      changes.notify();
      return Promise.resolve(LOGIN_CANCELLED);
    },
    logout() {
      calls.logouts += 1;
      changes.notify();
      return Promise.resolve({ phone: 'told' as const });
    },
    cancelLogin() {
      calls.cancels += 1;
      changes.notify();
    },
  };
  return { commands, calls };
}

/**
 * Holds each task until the test runs it, to force races. Dispose never aborts, as when a queue
 * starts a task before it processes that scope's disposal.
 */
function createManualCoordinator() {
  const tasks: { run: () => Promise<void>; disposed: () => boolean }[] = [];
  const coordinator: BlockingModalCoordinator = {
    createScope() {
      const signal = new AbortController().signal;
      let disposed = false;
      return {
        enqueue(task) {
          return new Promise(resolve => {
            tasks.push({
              async run() {
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
  return {
    /** The coordinator to give the controller. */
    coordinator,
    /** Every task enqueued, in order, each run by the test. */
    tasks,
  };
}

/** Rejects every lease with `error`, keeping each rejected lease so a test can wait for it to settle. */
function createRejectingCoordinator(error: Error) {
  const leases: Promise<never>[] = [];
  const coordinator: BlockingModalCoordinator = {
    createScope() {
      return {
        enqueue() {
          const lease = Promise.reject(error);
          leases.push(lease);
          return lease;
        },
        dispose: () => undefined,
      };
    },
  };
  return {
    /** The coordinator to give the controller. */
    coordinator,
    /** Every lease asked for, in order, each already rejected. */
    leases,
  };
}

/** A handoff whose rounds end when the test says, recording what the page asked of it. */
function createFakeHandoff() {
  let round: ReturnType<typeof createDeferred<SignInOutcome>> | null = null;
  let focuses = 0;
  const signIns: SignInIntent[] = [];
  const signOuts: { notified: boolean }[] = [];
  const cancels: PageCancelReason[] = [];

  function endRound(outcome: SignInOutcome): void {
    const open = round;
    round = null;
    open?.resolve(outcome);
  }

  return {
    /** The intent of every round the page opened, in order. */
    signIns,
    /** Every sign-out window the page opened, in order. */
    signOuts,
    /** How many times the page focused the open window. */
    get focuses(): number {
      return focuses;
    },
    /** Why each open round was ended by the page. */
    cancels,
    /** Opens a round, or joins the open one, which the test ends. */
    signIn(intent: SignInIntent): Promise<SignInOutcome> {
      signIns.push(intent);
      round ??= createDeferred<SignInOutcome>();
      return round.promise;
    },
    /** Records a sign-out window. */
    signOut(options: { notified: boolean }): void {
      signOuts.push(options);
    },
    /** Settles at once. */
    signOutRead: (): Promise<void> => Promise.resolve(),
    /** Records a focus of the open window. */
    focus(): void {
      focuses += 1;
    },
    /** Ends the open round as cancelled, recording why. As the real one, only an open round counts. */
    cancel(reason: PageCancelReason): void {
      if (round === null) {
        return;
      }
      cancels.push(reason);
      endRound({ kind: 'cancelled' });
    },
    /** Ends the open round with `outcome`, on behalf of the window or the user. */
    end(outcome: SignInOutcome): void {
      endRound(outcome);
    },
  };
}

/** A page whose sign-in goes through the window, signed out, with the waiting view of a first Sign in on show. */
function startWindowRound(params: StartControllerParams = {}) {
  const handoff = createFakeHandoff();
  const started = startController({ ...params, handoff });
  started.auth.set({ tag: 'Disconnected' });
  started.controller.startLogin();
  return { ...started, handoff };
}

/** Writes of the window's result the test settles, each one recorded as asked. */
function createHeldResults() {
  const results: SessionResult[] = [];
  const asked = createDeferred<SessionResult>();
  const written = createDeferred<'applied' | 'reloading'>();

  function holdResultWrite(result: SessionResult): Promise<'applied' | 'reloading'> {
    results.push(result);
    asked.resolve(result);
    return written.promise;
  }

  return {
    /** The write to give the controller. */
    applyResult: holdResultWrite,
    /** Resolves with the first result asked to be written. */
    asked: asked.promise,
    /** How the write ends, which the test settles. */
    written,
    /** Every result asked to be written, in order. */
    results,
  };
}

/**
 * What a page's boot hands the auth control slot, a page that pairs in place over `commands`, whose modal leases come
 * from `coordinator`, a fresh one by default.
 */
function buildInitParams(
  commands: AuthCommands,
  coordinator: BlockingModalCoordinator = createBlockingModalCoordinator(),
): Parameters<AuthControlSlot['init']>[0] {
  return {
    handoff: null,
    coordinator,
    bridge: () =>
      Promise.resolve({
        authCommands: commands,
        applyWindowResult: rejectNoResult,
        rereadSession: () => Promise.resolve(),
        walletSwitch: NO_WALLET_SWITCH,
      }),
    loadRecoveryPhrase: rejectNoPhrase,
  };
}

describe('auth controller: login requests', () => {
  it('As a user asked by a product to sign in, I see its label and reason in the modal and the core is asked to log in', async () => {
    // Given a signed-out page
    const { controller, auth, calls, changes } = startController();
    auth.set({ tag: 'Disconnected' });

    // When a product asks for a sign-in
    controller.startLogin({ reason: 'Sign the transfer', label: 'localhost:3000' });
    const modal = getAuthModalState();
    await changes.until(() => calls.logins.length === 1);

    // Then the modal names the product and its reason, and the core was asked with the reason
    expect(modal).toEqual({
      open: true,
      productLabel: 'localhost:3000',
      reason: 'Sign the transfer',
      view: { kind: 'spinner' },
    });
    expect(calls.logins).toEqual(['Sign the transfer']);
  });

  it("As a user asked by a deployed product to sign in, I open the modal and see the active network's TLD in its title", () => {
    // Given a page
    const { controller } = startController();

    // When a deployed product asks for a sign-in
    controller.startLogin({ label: 'foo' });

    // Then the label carries the active TLD and there is no reason
    expect(getAuthModalState().productLabel).toBe(withActiveTld('foo'));
    expect(getAuthModalState().reason).toBeNull();
  });

  it('As a user on the landing page, I click Sign in while my saved session cannot be reached and pair once it reads signed out', async () => {
    // Given a page that pairs in place, whose saved session cannot be reached until it is read again
    const { controller, auth, calls, changes } = startController({
      rereadSession() {
        auth.set({ tag: 'Disconnected' });
        return Promise.resolve();
      },
    });
    auth.set({ tag: 'Unreachable' });

    // When Sign in is clicked
    controller.startLogin({ reason: 'Sign in to continue' });
    await changes.until(() => calls.logins.length === 1);

    // Then the core is asked once to log in, with the click's reason
    expect(calls.logins).toEqual(['Sign in to continue']);
  });

  it('As a user on a product, I click Sign in while my saved session cannot be reached and am asked to continue once it reads signed out', async () => {
    // Given a page with a sign-in window, whose saved session cannot be reached until it is read again
    const handoff = createFakeHandoff();
    const { controller, auth, changes } = startController({
      handoff,
      rereadSession() {
        auth.set({ tag: 'Disconnected' });
        return Promise.resolve();
      },
    });
    auth.set({ tag: 'Unreachable' });

    // When Sign in is clicked, and then the prompt's button
    controller.startLogin();
    await changes.until(() => getAuthModalState().view.kind === 'prompt');
    const signInsAtPrompt = [...handoff.signIns];
    controller.retryLogin();

    // Then no window opened before the prompt, and its button opened one
    expect(signInsAtPrompt).toEqual([]);
    expect(handoff.signIns).toEqual(['signin']);
  });

  it('As a user whose saved sign-in still cannot be reached, I click Sign in and am told so with a retry', async () => {
    // Given a page whose saved session stays out of reach when read again
    const { controller, auth, calls, changes } = startController();
    auth.set({ tag: 'Unreachable' });

    // When Sign in is clicked
    controller.startLogin();
    await changes.until(() => getAuthModalState().view.kind === 'error');

    // Then the modal offers a retry and the core was asked nothing
    expect(getAuthModalState().view).toMatchObject({ kind: 'error', retry: true });
    expect(calls.logins).toEqual([]);
  });

  it.each<[string, DotliAuthState]>([
    ['reads signed in', SIGNED_IN],
    ['finds a pairing started meanwhile', PAIRING],
  ])('As a user whose saved session %s when read again, I click Sign in and no login starts', async (_case, read) => {
    // Given a page whose saved session cannot be reached until it is read again
    const { controller, auth, calls } = startController({
      rereadSession() {
        auth.set(read);
        return Promise.resolve();
      },
    });
    auth.set({ tag: 'Unreachable' });

    // When Sign in is clicked and the session is read
    controller.startLogin();
    await untilPromisesSettled();

    // Then the core was asked no login
    expect(calls.logins).toEqual([]);
  });

  it('As a user who closes the dialog while the saved session is read again, I see nothing more', async () => {
    // Given a page whose saved session cannot be reached, closed by the user while it is read again
    let close = (): void => undefined;
    const { controller, auth, calls } = startController({
      rereadSession() {
        close();
        auth.set({ tag: 'Disconnected' });
        return Promise.resolve();
      },
    });
    close = () => {
      controller.closeAuthModal();
    };
    auth.set({ tag: 'Unreachable' });

    // When Sign in is clicked and the session is read
    controller.startLogin();
    await untilPromisesSettled();

    // Then the modal stays closed and the core was asked no login
    expect(getAuthModalState()).toEqual(CLOSED_MODAL);
    expect(calls.logins).toEqual([]);
  });

  it('As a user whose page failed to load its sign-in code, I click Sign in and am told the sign-in cannot be reached', async () => {
    // Given a page whose saved session cannot be reached and whose read of it fails to load
    const logged = recordLog({ onFinished: onTestFinished, level: 'error' });
    const { controller, auth, changes } = startController({
      rereadSession: () => Promise.reject(new Error('Failed to fetch dynamically imported module')),
    });
    auth.set({ tag: 'Unreachable' });

    // When Sign in is clicked
    controller.startLogin();
    await changes.until(() => getAuthModalState().view.kind === 'error');

    // Then the modal offers a retry and the failure was logged once
    expect(getAuthModalState().view).toMatchObject({ kind: 'error', retry: true });
    expect(logged).toHaveLength(1);
  });

  it('As a user who asked for a recovery phrase while my saved session could not be read, I press Retry and am asked for the phrase again', async () => {
    // Given a page that pairs in place, whose first read of the saved session fails and whose second reads signed out
    let reads = 0;
    let phraseLoads = 0;
    const { controller, auth, calls, changes } = startController({
      rereadSession() {
        reads += 1;
        if (reads === 1) {
          return Promise.reject(new Error('Failed to fetch dynamically imported module'));
        }
        auth.set({ tag: 'Disconnected' });
        return Promise.resolve();
      },
      loadRecoveryPhrase() {
        phraseLoads += 1;
        return rejectNoPhrase();
      },
    });
    recordLog({ onFinished: onTestFinished, level: 'error' });
    auth.set({ tag: 'Unreachable' });
    controller.importPhrase();
    await changes.until(() => getAuthModalState().view.kind === 'error');

    // When Retry is pressed
    controller.retryLogin();
    await untilPromisesSettled();

    // Then the phrase is asked for again and no login starts
    expect(phraseLoads).toBe(1);
    expect(calls.logins).toEqual([]);
  });

  it('As a user whose phrase failed to load, I sign in instead and press Retry after that login fails, and a login starts again', async () => {
    // Given a page that pairs in place, whose phrase import failed to load and whose login then failed
    let phraseLoads = 0;
    const { controller, auth, calls, changes } = startController({
      loadRecoveryPhrase() {
        phraseLoads += 1;
        return rejectNoPhrase();
      },
    });
    auth.set({ tag: 'Disconnected' });
    controller.importPhrase();
    await changes.until(() => getAuthModalState().view.kind === 'error');
    controller.startLogin();
    await changes.until(() => calls.logins.length === 1);
    auth.set({ tag: 'LoginFailed', kind: 'Other', reason: 'the phone said no' });

    // When Retry is pressed
    controller.retryLogin();
    await untilPromisesSettled();

    // Then a login starts again and no phrase is asked for
    expect(calls.logins).toHaveLength(2);
    expect(phraseLoads).toBe(1);
  });

  it('As a user whose sign-in modal is disabled, I click Sign in while my saved session cannot be reached and nothing is read', async () => {
    // Given a page whose modal is disabled and whose saved session cannot be reached
    let reads = 0;
    const { controller, auth } = startController({
      rereadSession() {
        reads += 1;
        return Promise.resolve();
      },
    });
    controller.disableAuthModal();
    auth.set({ tag: 'Unreachable' });

    // When Sign in is clicked
    controller.startLogin();
    await untilPromisesSettled();

    // Then the saved session was not read again
    expect(reads).toBe(0);
  });

  it('As a user, I click Sign in again while the QR is shown and the QR stays while the core is asked once', async () => {
    // Given: a login whose pairing QR is on screen
    const { controller, auth, calls, changes } = startController();
    auth.set({ tag: 'Disconnected' });
    controller.startLogin();
    auth.set(PAIRING);

    // When Sign in is clicked again
    controller.startLogin();
    const view = getAuthModalState().view;
    await changes.until(() => calls.logins.length === 1);

    // Then the QR stays and the core was asked once
    expect(view).toEqual({ kind: 'pairing', payload: PAIRING.deeplink });
    expect(calls.logins).toEqual([undefined]);
  });

  it('As a user who closed the QR code, I click Sign in before the core reports the cancel and get a new QR code', async () => {
    // Given: a QR code the user closed, while the core still reports the pairing
    const { controller, auth, calls, changes } = startController();
    auth.set({ tag: 'Disconnected' });
    controller.startLogin();
    auth.set(PAIRING);
    await changes.until(() => calls.logins.length === 1);
    controller.closeAuthModal();
    await changes.until(() => calls.cancels === 1);

    // When Sign in is clicked, and the core's next pairing arrives
    controller.startLogin();
    await changes.until(() => calls.logins.length === 2);
    const reopened = getAuthModalState();
    auth.set({ ...PAIRING, deeplink: 'polkadotapp://pair?handshake=again' });

    // Then: the modal opened and the core was asked again, so its next pairing shows a new QR code
    expect(reopened).toMatchObject({ open: true, view: { kind: 'spinner' } });
    expect(getAuthModalState().view).toEqual({ kind: 'pairing', payload: 'polkadotapp://pair?handshake=again' });
  });

  it('As a user on the error view, I press Retry and the spinner opens while the core is asked to log in again', async () => {
    // Given a failed login
    const { controller, auth, calls, changes } = startController();
    auth.set({ tag: 'LoginFailed', kind: 'Other', reason: 'Host failure' });

    // When Retry is pressed
    controller.startLogin();
    const modal = getAuthModalState();
    await changes.until(() => calls.logins.length === 1);

    // Then the spinner shows and the core was asked again
    expect(modal.view).toEqual({ kind: 'spinner' });
    expect(modal.open).toBe(true);
    expect(calls.logins).toEqual([undefined]);
  });

  it('As a user on the error view, I retry and a retry that fails the same way shows the error again', () => {
    // Given: a login failed, and the user retried.
    const { controller, auth } = startController();
    const failed = {
      tag: 'LoginFailed',
      kind: 'Other',
      reason: 'worker init failed',
    } as const;
    auth.set({ ...failed });
    controller.startLogin();
    const retryView = getAuthModalState().view;

    // When: the bridge reports the same failure again.
    auth.set({ ...failed });

    // Then the spinner showed for the retry, and the error shows again
    expect(retryView).toEqual({ kind: 'spinner' });
    expect(getAuthModalState().view).toMatchObject({
      kind: 'error',
      message: 'worker init failed',
    });
  });

  it('As a user whose bridge chunk failed at boot, I click Sign in and see the failure while no new issue opens', async () => {
    // Given a bridge chunk that failed to load
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const exceptions = captureExceptions();
    const failure = new TypeError('Failed to fetch dynamically imported module');
    const { controller, auth, changes } = startController({ commands: () => Promise.reject(failure) });
    auth.set({ tag: 'Disconnected' });

    // When Sign in is clicked
    controller.startLogin();
    await changes.until(() => getAuthModalState().view.kind === 'error');

    // Then the failure shows and nothing is captured or counted
    expect(getAuthModalState().view).toMatchObject({ kind: 'error', title: 'The sign-in service did not start' });
    expect(exceptions).toEqual([]);
    expect(metrics.counted('auth.command')).toEqual([]);
  });

  it('As an operator, I see a command that throws once the chunk loaded captured and counted under the command metric', async () => {
    // Given commands whose login rejects
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const exceptions = captureExceptions();
    const failure = new TypeError('login exploded');
    const failing: AuthCommands = {
      login: () => Promise.reject(failure),
      logout: () => Promise.resolve({ phone: 'told' as const }),
      cancelLogin: () => undefined,
    };
    const { controller, auth, changes } = startController({ commands: () => Promise.resolve(failing) });
    auth.set({ tag: 'Disconnected' });

    // When Sign in is clicked and the login fails
    controller.startLogin();
    await changes.until(() => getAuthModalState().view.kind === 'error');

    // Then the failure is captured and counted under the login step
    expect(exceptions).toMatchObject([[failure, { step: 'login' }]]);
    expect(metrics.counted('auth.command')).toEqual([{ outcome: 'error', reason: 'TypeError', step: 'login' }]);
  });

  it('As a user, I press Sign out in the account popover and the core is asked to log out', async () => {
    // Given a page
    const { controller, calls, changes } = startController();

    // When Sign out is pressed
    controller.logout();
    await changes.until(() => calls.logouts === 1);

    // Then the core was asked once
    expect(calls.logouts).toBe(1);
  });
});

describe('auth controller: blocking-modal lease', () => {
  it('As a user with a blocking prompt on screen, I ask for the sign-in modal and it opens only once the prompt is answered', async () => {
    // Given a blocking prompt on screen
    const { controller, coordinator } = startController();
    const scope = coordinator.createScope();
    const held = createDeferred<undefined>();
    const prompt = scope.enqueue(() => held.promise);
    onTestFinished(() => {
      controller.closeAuthModal();
      scope.dispose();
    });

    // When the modal is asked for, and then the prompt is answered
    controller.openAuthModal();
    const openWhilePrompted = getAuthModalState().open;
    held.resolve(undefined);
    await prompt;

    // Then the modal waited for the prompt and then opened
    expect([openWhilePrompted, getAuthModalState().open]).toEqual([false, true]);
  });

  it('As a user, I ask for the modal twice over a close and only the newest request holds the lease', async () => {
    // Given two overlapping requests for the modal
    const { coordinator, tasks } = createManualCoordinator();
    const { controller } = startController({ coordinator });
    controller.openAuthModal();
    controller.closeAuthModal({ skipTruapiCancel: true });
    controller.openAuthModal();
    const queued = { count: tasks.length, staleDisposed: nth(tasks, 0).disposed() };
    const stale = nth(tasks, 0);
    const current = nth(tasks, 1);

    // When: the replaced scope's task starts with a live signal, then the newest one, and closing releases it
    await stale.run();
    const openAfterStale = getAuthModalState().open;
    const running = current.run();
    const openAfterCurrent = getAuthModalState().open;
    controller.closeAuthModal({ skipTruapiCancel: true });
    await running;

    // Then: the replaced task never opened the modal, the newest one did, and the close released it
    expect(queued).toEqual({ count: 2, staleDisposed: true });
    expect([openAfterStale, openAfterCurrent, getAuthModalState().open]).toEqual([false, true, false]);
  });

  it('As a user, I ask for the modal again while its lease is pending and the one lease serves both', async () => {
    // Given two requests for the modal before its lease is granted
    const { coordinator, tasks } = createManualCoordinator();
    const { controller } = startController({ coordinator });
    controller.openAuthModal();
    controller.openAuthModal({ reason: 'again' });

    // When: the one pending lease is granted, then the modal is closed once
    const running = nth(tasks, 0).run();
    const shown = getAuthModalState();
    controller.closeAuthModal({ skipTruapiCancel: true });
    await running;

    // Then: the modal opened with the second call's reason over one lease, which the close released
    expect(shown).toMatchObject({ open: true, reason: 'again' });
    expect(tasks).toHaveLength(1);
    expect(getAuthModalState().open).toBe(false);
  });

  it('As a user, I close the modal and its lease is released while the login in flight is cancelled once', async () => {
    // Given an open modal and another prompt waiting for its lease
    const { controller, coordinator, calls, changes } = startController();
    controller.openAuthModal({ reason: 'why', label: 'localhost:3000' });
    const openBefore = getAuthModalState().open;
    const next = coordinator.createScope();
    onTestFinished(() => {
      next.dispose();
    });
    let nextRan = false;

    // When the waiting prompt is queued and the modal closes
    const queued = next.enqueue(() => {
      nextRan = true;
    });
    controller.closeAuthModal();
    await queued;
    await changes.until(() => calls.cancels === 1);

    // Then the waiting prompt ran and the modal is closed
    expect(openBefore).toBe(true);
    expect(nextRan).toBe(true);
    expect(getAuthModalState()).toEqual({
      open: false,
      productLabel: null,
      reason: null,
      view: { kind: 'spinner' },
    });
  });

  it('As a dotli integrator, I disable the modal while a login holds its lease and that login is cancelled once, while later opens and retries cancel instead of presenting', async () => {
    // Given an open modal for a login and another prompt waiting for its lease
    const { controller, coordinator, calls, auth, changes } = startController();
    auth.set({ tag: 'Disconnected' });
    controller.openAuthModal({ reason: 'why', label: 'localhost:3000' });
    const openBefore = getAuthModalState().open;
    const next = coordinator.createScope();
    onTestFinished(() => {
      next.dispose();
    });
    let nextRan = false;
    const queued = next.enqueue(() => {
      nextRan = true;
    });

    // When the modal is disabled, and later a login opens it and Sign in is clicked
    controller.disableAuthModal();
    await queued;
    await changes.until(() => calls.cancels === 1);
    const afterDisable = { nextRan, open: getAuthModalState().open };
    const presented = controller.openAuthModal();
    controller.startLogin();
    await changes.until(() => calls.cancels === 3);

    // Then the lease went to the waiting prompt, and the later open and Sign in each cancelled instead
    expect(openBefore).toBe(true);
    expect(afterDisable).toEqual({ nextRan: true, open: false });
    expect(presented).toBe(false);
    expect(calls.logins).toEqual([]);
    expect(getAuthModalState().open).toBe(false);
  });

  it('As a dotli integrator, I disable the modal with no login in flight and nothing is cancelled', async () => {
    // Given a page
    const { controller, calls, changes } = startController();

    // When the modal is disabled and a logout follows
    controller.disableAuthModal();
    controller.logout();
    await changes.until(() => calls.logouts === 1);

    // Then: the logout ran, and no cancel came before it
    expect(calls.cancels).toBe(0);
  });

  it('As an operator, I see a modal lease that fails captured, logged as an error and counted', async () => {
    // Given a coordinator whose leases fail
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const exceptions = captureExceptions();
    const logged = recordLog({ onFinished: onTestFinished, level: 'error' });
    const failure = new TypeError('the prompt queue broke');
    const { coordinator, leases } = createRejectingCoordinator(failure);
    const { controller } = startController({ coordinator });

    // When the modal is asked for and its lease fails
    controller.openAuthModal();
    await nth(leases, 0).catch(() => undefined);

    // Then the failure is captured, logged as an error and counted
    expect(exceptions).toMatchObject([[failure, { step: 'auth_modal_lease' }]]);
    expect(logged.map(line => line.args)).toEqual([['[dot.li auth] authentication modal lease failed:', failure]]);
    expect(metrics.counted('auth.modal_lease')).toEqual([{ outcome: 'error', reason: 'TypeError' }]);
  });

  it("As a user, I close the modal and its lease's abort reports nothing", async () => {
    // Given a coordinator whose leases end in an abort, as a closed modal's do
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const exceptions = captureExceptions();
    const { coordinator, leases } = createRejectingCoordinator(
      new DOMException('Authentication modal closed', 'AbortError'),
    );
    const { controller } = startController({ coordinator });

    // When the modal is asked for and its lease aborts
    controller.openAuthModal();
    await nth(leases, 0).catch(() => undefined);

    // Then nothing is captured or counted
    expect(exceptions).toEqual([]);
    expect(metrics.counted('auth.modal_lease')).toEqual([]);
  });

  it('As a user whose page dropped its sign-in controller, I see a login it left running fail and no modal holds up my later prompts', async () => {
    // Given a login under way whose controller is then disposed
    const exceptions = captureExceptions();
    const failure = new Error('The paired session could not be stored');
    const pending = createDeferred<LoginOutcome>();
    const failing: AuthCommands = {
      login: () => pending.promise,
      logout: () => Promise.resolve({ phone: 'told' as const }),
      cancelLogin: () => undefined,
    };
    const { controller, auth, coordinator, changes } = startController({ commands: () => Promise.resolve(failing) });
    auth.set({ tag: 'Disconnected' });
    controller.startLogin();
    await changes.until(() => getAuthModalState().open);
    controller.dispose();

    // When the login fails and another prompt asks for the screen
    pending.reject(failure);
    await untilPromisesSettled();
    let promptShown = false;
    void coordinator.createScope().enqueue(() => {
      promptShown = true;
      return Promise.resolve();
    });
    await untilPromisesSettled();

    // Then the failure was reported, the modal stayed closed and the prompt showed
    expect(exceptions).toMatchObject([[failure, { step: 'login' }]]);
    expect(getAuthModalState()).toEqual(CLOSED_MODAL);
    expect(promptShown).toBe(true);
  });

  it('As a dotli integrator, I call a disposed controller and nothing opens, signs in or out, and a phrase import is refused', async () => {
    // Given a disposed controller on a page that pairs in place
    const exceptions = captureExceptions();
    const { controller, auth, calls } = startController();
    auth.set({ tag: 'Disconnected' });
    controller.dispose();

    // When every member is called, dispose again included
    controller.dispose();
    const opened = controller.openAuthModal();
    controller.startLogin();
    controller.importPhrase();
    controller.retryLogin();
    controller.logout();
    controller.focusSignInWindow();
    controller.disableAuthModal();
    controller.closeAuthModal();
    const valid = controller.isValidPhrase(PHRASE);
    const imported = await controller.importPhraseInPage(PHRASE).catch((error: unknown) => error);
    await untilPromisesSettled();

    // Then nothing reached the core or the modal, and the import was refused as the page's fault
    expect(opened).toBe(false);
    expect(valid).toBe(false);
    expect(imported).toEqual(new Error('The sign-in controller was disposed'));
    expect(calls).toEqual({ logins: [], logouts: 0, cancels: 0 });
    expect(getAuthModalState()).toEqual(CLOSED_MODAL);
    expect(exceptions).toMatchObject([[imported, { step: 'local_wallet' }]]);
  });

  it('As a dotli integrator, I call a disposed controller on a page with the sign-in window and no window opens, closes or comes forward', async () => {
    // Given a disposed controller on a signed-out page with the sign-in window
    const handoff = createFakeHandoff();
    const { controller, auth, calls } = startController({ handoff });
    auth.set({ tag: 'Disconnected' });
    controller.dispose();

    // When every member that reaches the window is called
    controller.startLogin();
    controller.importPhrase();
    controller.retryLogin();
    controller.logout();
    controller.focusSignInWindow();
    controller.closeAuthModal();
    controller.disableAuthModal();
    await untilPromisesSettled();

    // Then the window was never asked for anything and the core heard nothing
    expect({
      signIns: handoff.signIns,
      signOuts: handoff.signOuts,
      focuses: handoff.focuses,
      cancels: handoff.cancels,
    }).toEqual({ signIns: [], signOuts: [], focuses: 0, cancels: [] });
    expect(calls).toEqual({ logins: [], logouts: 0, cancels: 0 });
  });

  it('As a user whose page dropped its sign-in controller while the modal waited for a prompt, I answer the prompt and no modal opens', async () => {
    // Given a blocking prompt on screen, the modal asked for behind it, and the controller then disposed
    const { controller, coordinator } = startController();
    const scope = coordinator.createScope();
    const held = createDeferred<undefined>();
    const prompt = scope.enqueue(() => held.promise);
    onTestFinished(() => {
      scope.dispose();
    });
    controller.openAuthModal();
    controller.dispose();

    // When the prompt is answered and another prompt asks for the screen
    held.resolve(undefined);
    await prompt;
    await untilPromisesSettled();
    let promptShown = false;
    void coordinator.createScope().enqueue(() => {
      promptShown = true;
      return Promise.resolve();
    });
    await untilPromisesSettled();

    // Then the modal stayed closed and the later prompt showed
    expect(getAuthModalState()).toEqual(CLOSED_MODAL);
    expect(promptShown).toBe(true);
  });
});

describe('auth controller: auth states', () => {
  it('As a user whose core starts pairing, I see the modal open with the QR payload and the product label', () => {
    // Given a page
    const { auth } = startController();

    // When the core pairs
    auth.set(PAIRING);

    // Then the modal shows the pairing
    expect(getAuthModalState()).toEqual({
      open: true,
      productLabel: 'localhost:3000',
      reason: null,
      view: { kind: 'pairing', payload: 'polkadotapp://pair?handshake=test' },
    });
  });

  it('As a user on the landing page, I pair host-global and the modal names no product', () => {
    // Given a page
    const { auth } = startController();

    // When the core pairs host-global
    auth.set({
      ...PAIRING,
      label: 'Polkadot Web',
      dotSuffix: false,
      hostGlobal: true,
    });

    // Then no product label shows
    expect(getAuthModalState().productLabel).toBeNull();
  });

  it('As a user whose core pairs without a deeplink yet, I wait for it and see the spinner', () => {
    // Given a page
    const { auth } = startController();

    // When the core pairs with no deeplink
    auth.set({ ...PAIRING, deeplink: '' });

    // Then the spinner shows
    expect(getAuthModalState().view).toEqual({ kind: 'spinner' });
  });

  it('As a user scanning the QR code, I authenticate and see progress replace the QR while the modal stays open', () => {
    // Given a pairing on show
    const { auth } = startController();
    auth.set(PAIRING);

    // When the core authenticates
    auth.set({ tag: 'Authenticating' });

    // Then progress shows in the open modal
    expect(getAuthModalState().view).toEqual({ kind: 'authenticating' });
    expect(getAuthModalState().open).toBe(true);
  });

  it('As a user, I finish pairing and the modal closes without cancelling the login', async () => {
    // Given a pairing on show
    const { controller, auth, calls, changes } = startController();
    auth.set(PAIRING);

    // When the core connects, and a logout follows
    auth.set({ tag: 'Connected', session: { connected: true } });
    const openAfterConnect = getAuthModalState().open;
    controller.logout();
    await changes.until(() => calls.logouts === 1);

    // Then: the modal closed, the logout behind it ran, and no cancel came before it
    expect(openAfterConnect).toBe(false);
    expect(calls.cancels).toBe(0);
  });

  it('As a user pairing after a session, I see the core report Disconnected and the pairing stays on screen', () => {
    // Given a pairing on show after a session
    const { auth } = startController();
    auth.set({ tag: 'Connected', session: { connected: true } });
    auth.set(PAIRING);

    // When the core reports Disconnected
    auth.set({ tag: 'Disconnected' });

    // Then the pairing stays
    expect(getAuthModalState().open).toBe(true);
    expect(getAuthModalState().view.kind).toBe('pairing');
  });

  it('As a new user, I fail to log in and the host-global modal opens with retryable error copy', () => {
    // Given a page
    const { auth } = startController();

    // When the login fails
    auth.set({
      tag: 'LoginFailed',
      kind: 'Other',
      reason: 'User declined the request',
    });

    // Then the error copy shows with a retry
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

  it.each([
    {
      user: 'a new user whose account is still being set up',
      failure: { tag: 'LoginFailed', kind: 'Other', reason: 'OriginPersonProviderError: not yet' },
      shown: 'the failure as a wait',
      view: { kind: 'error', pending: true, title: 'Your account is still being set up' },
    },
    {
      user: 'a new user whose allowance is exhausted',
      failure: { tag: 'LoginFailed', kind: 'NoFreeAllowanceSlots', reason: 'no slots' },
      shown: 'no retry offered',
      view: { kind: 'error', retry: false, title: 'No Statement Store slots left', detail: 'no slots' },
    },
    {
      user: 'a new user whose account is still being set up',
      failure: { tag: 'LoginFailed', kind: 'Other', reason: 'OriginPersonProviderError' },
      shown: 'the raw reason hidden',
      view: {
        kind: 'error',
        message: 'OriginPersonProviderError',
        retry: true,
        title: 'Your account is still being set up',
        detail: undefined,
      },
    },
  ] as const)('As $user, I fail to log in and see $shown', ({ failure, view }) => {
    // Given a page
    const { auth } = startController();

    // When the login fails
    auth.set({ ...failure });

    // Then the error view shows as the row says
    expect(getAuthModalState().view).toMatchObject(view);
  });
});

describe('auth controller: the sign-in window', () => {
  it('As a debug panel user, I import a phrase and the window opens at its phrase view while I wait', () => {
    // Given a signed-out page with a sign-in window
    const handoff = createFakeHandoff();
    const { controller, auth, calls } = startController({ handoff });
    auth.set({ tag: 'Disconnected' });

    // When the debug panel imports a phrase
    controller.importPhrase();

    // Then: opened in the click's own turn, and the core is not asked to pair
    expect(handoff.signIns).toEqual(['phrase']);
    expect(getAuthModalState()).toEqual({ open: true, productLabel: null, reason: null, view: { kind: 'window' } });
    expect(calls.logins).toEqual([]);
  });

  it('As a signed-in debug panel user typing a phrase in the sign-in window, I see my session reported again and the window stays open', () => {
    // Given a signed-in page in local mode whose phrase window is open
    const handoff = createFakeHandoff();
    const { controller, auth } = startController({ handoff, local: true });
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
    const { phrase } = createFakePhrase();
    const { controller, auth, calls, changes } = startController({ loadRecoveryPhrase: () => Promise.resolve(phrase) });
    auth.set({ tag: 'Disconnected' });

    // When the debug panel imports a phrase, and the view checks a phrase and a non-phrase
    controller.importPhrase();
    await changes.until(() => getAuthModalState().view.kind === 'phrase');
    const verdicts = [controller.isValidPhrase(PHRASE), controller.isValidPhrase('not a phrase')];

    // Then the view shows once its phrase check loaded, and no pairing starts
    expect(getAuthModalState().open).toBe(true);
    expect(verdicts).toEqual([true, false]);
    expect(calls.logins).toEqual([]);
  });

  it('As a debug panel user on a page that pairs in place, I import my phrase and it is used for every app', async () => {
    // Given the modal open at its phrase view
    const { phrase, walletSwitch, used } = createFakePhrase();
    const { controller, changes } = startController({
      loadRecoveryPhrase: () => Promise.resolve(phrase),
      walletSwitch,
    });
    controller.importPhrase();
    await changes.until(() => getAuthModalState().view.kind === 'phrase');

    // When a valid phrase is imported
    await controller.importPhraseInPage(PHRASE);

    // Then its entropy is used as the local wallet
    expect(used).toEqual([ENTROPY]);
  });

  it('As a debug panel user on a page that pairs in place, I enter a phrase that is not one and nothing is saved', async () => {
    // Given the modal open at its phrase view
    const { phrase, walletSwitch, used } = createFakePhrase();
    const { controller, changes } = startController({
      loadRecoveryPhrase: () => Promise.resolve(phrase),
      walletSwitch,
    });
    controller.importPhrase();
    await changes.until(() => getAuthModalState().view.kind === 'phrase');
    const exceptions = captureExceptions();

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
    const exceptions = captureExceptions();
    const { controller } = startController();

    // When a phrase is imported before the module loaded
    const imported = controller.importPhraseInPage(PHRASE);

    // Then the import rejects and the load failure is reported and counted
    await expect(imported).rejects.toThrow('The recovery phrase import was not loaded');
    expect(exceptions).toMatchObject([[expect.any(Error), { step: 'local_wallet', tags: { reason: 'phrase-load' } }]]);
    expect(metrics.counted('wallet.local_activate')).toEqual([{ outcome: 'error', reason: 'phrase-load' }]);
  });

  it('As a debug panel user on a page that pairs in place, I import a phrase whose wallet could not be saved and the form says so', async () => {
    // Given the modal at its phrase view over a wallet save that fails
    const { phrase, walletSwitch } = createFakePhrase({ outcome: 'failed' });
    const { controller, changes } = startController({
      loadRecoveryPhrase: () => Promise.resolve(phrase),
      walletSwitch,
    });
    controller.importPhrase();
    await changes.until(() => getAuthModalState().view.kind === 'phrase');

    // When a valid phrase is imported
    const imported = controller.importPhraseInPage(PHRASE);

    // Then the form says it, and the modal stays on the phrase view
    await expect(imported).rejects.toThrow('The recovery phrase wallet could not be saved');
    expect(getAuthModalState().view.kind).toBe('phrase');
  });

  it("As a debug panel user typing a phrase, I keep my phrase view on show while a product's pairing runs and fails", async () => {
    // Given a signed-out page whose modal shows the phrase view
    const { phrase } = createFakePhrase();
    const { controller, auth, changes } = startController({ loadRecoveryPhrase: () => Promise.resolve(phrase) });
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
    const { phrase } = createFakePhrase();
    const loaded = createDeferred<PhraseCheck>();
    const { controller } = startController({ loadRecoveryPhrase: () => loaded.promise });
    controller.importPhrase();

    // When the modal closes and then the check loads
    controller.closeAuthModal({ skipTruapiCancel: true });
    loaded.resolve(phrase);
    // The controller takes the check after its bridge load joins it, which no fake is told of.
    await untilPromisesSettled();

    // Then the modal stays closed
    expect(getAuthModalState()).toEqual(CLOSED_MODAL);
  });

  it('As a debug panel user whose phrase check could not load, I see the failure, and Retry opens the phrase view', async () => {
    // Given a phrase check whose first load fails
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const { phrase } = createFakePhrase();
    let loads = 0;
    const { controller, calls, changes } = startController({
      loadRecoveryPhrase: () => (++loads === 1 ? Promise.reject(new Error('chunk failed')) : Promise.resolve(phrase)),
    });

    // When the debug panel imports a phrase, sees the failure and presses Retry
    controller.importPhrase();
    await changes.until(() => getAuthModalState().view.kind === 'error');
    const countedAtFailure = metrics.counted('lazy_chunk.load');
    controller.retryLogin();
    await changes.until(() => getAuthModalState().view.kind === 'phrase');

    // Then the missed chunk was counted, the phrase view opened, and no pairing starts
    expect(countedAtFailure).toEqual([{ outcome: 'error', reason: 'phrase_import' }]);
    expect(calls.logins).toEqual([]);
  });

  it("As a debug panel user whose phrase check could not load, I watch a product's pairing fail and Retry signs me in", async () => {
    // Given a failed phrase import, then a product's pairing that failed over it
    captureExceptions();
    let loads = 0;
    const { controller, auth, calls, changes } = startController({
      loadRecoveryPhrase: () => {
        loads++;
        return Promise.reject(new Error('chunk failed'));
      },
    });
    controller.importPhrase();
    await changes.until(() => getAuthModalState().view.kind === 'error');
    auth.set(PAIRING);
    auth.set({ tag: 'LoginFailed', kind: 'Other', reason: 'timed out' });

    // When the user presses Retry
    controller.retryLogin();
    await untilPromisesSettled();

    // Then a login was asked for and the phrase import was asked once
    expect(calls.logins).toEqual([undefined]);
    expect(loads).toBe(1);
  });

  it('As a debug panel user, I import while the saved session cannot be reached and am shown why', async () => {
    // Given a page whose saved session cannot be reached, and whose re-read leaves it so
    const handoff = createFakeHandoff();
    const { controller, auth, changes } = startController({ handoff });
    auth.set({ tag: 'Unreachable' });

    // When the debug panel imports a phrase
    controller.importPhrase();
    await changes.until(() => getAuthModalState().view.kind === 'error');

    // Then the modal says the saved sign-in cannot be reached, and no window opens
    expect(getAuthModalState()).toMatchObject({ open: true, view: { title: "Can't reach your saved sign-in" } });
    expect(handoff.signIns).toEqual([]);
  });

  it('As a debug panel user on a page that pairs in place, I import while the saved session cannot be reached and see the phrase view once it reads signed out', async () => {
    // Given a page that pairs in place, whose saved session cannot be reached until it is read again
    const { phrase } = createFakePhrase();
    const { controller, auth, calls, changes } = startController({
      loadRecoveryPhrase: () => Promise.resolve(phrase),
      rereadSession() {
        auth.set({ tag: 'Disconnected' });
        return Promise.resolve();
      },
    });
    auth.set({ tag: 'Unreachable' });

    // When the debug panel imports a phrase
    controller.importPhrase();
    await changes.until(() => getAuthModalState().view.kind === 'phrase');

    // Then the phrase view shows, and no pairing starts
    expect(calls.logins).toEqual([]);
  });

  it('As a user on a product, I press Sign in and the window opens with the waiting view', () => {
    // Given a signed-out page with a sign-in window
    const handoff = createFakeHandoff();
    const { controller, auth, calls } = startController({ handoff });
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
    const held = createHeldResults();
    const { auth, handoff, calls, changes } = startWindowRound({ applyResult: held.applyResult });

    // When: the window's own store write signs the page in before its result arrives, then the result is written
    auth.set(SIGNED_IN);
    const early = { cancels: [...handoff.cancels], view: getAuthModalState().view, coreCancels: calls.cancels };
    handoff.end({ kind: 'result', result: RESULT });
    const asked = await held.asked;
    held.written.resolve('applied');
    await changes.until(() => !getAuthModalState().open);

    // Then: the round and its window stayed, so the result with the account landed, and the modal closes
    expect(early).toEqual({ cancels: [], view: { kind: 'window' }, coreCancels: 0 });
    expect(asked).toBe(RESULT);
    expect(getAuthModalState()).toEqual(CLOSED_MODAL);
  });

  it('As a user, I finish signing in through the window and its result is written into this page while the waiting view closes', async () => {
    // Given a window round whose result write is held
    const held = createHeldResults();
    const { controller, handoff, changes } = startWindowRound({ applyResult: held.applyResult });

    // When the result comes, the user presses Sign in meanwhile, and the write is done
    handoff.end({ kind: 'result', result: RESULT });
    const asked = await held.asked;
    controller.startLogin();
    const whileWriting = { view: getAuthModalState().view, signIns: [...handoff.signIns] };
    held.written.resolve('applied');
    await changes.until(() => !getAuthModalState().open);

    // Then: the waiting view stayed until the write was done, and Sign in meanwhile started no second round
    expect(asked).toBe(RESULT);
    expect(whileWriting).toEqual({ view: { kind: 'window' }, signIns: ['signin'] });
    expect(getAuthModalState()).toEqual(CLOSED_MODAL);
  });

  it('As a user, I press Cancel while the result is being written and no waiting view comes back', async () => {
    // Given: a result being written
    const held = createHeldResults();
    const { controller, handoff } = startWindowRound({ applyResult: held.applyResult });
    handoff.end({ kind: 'result', result: RESULT });
    await held.asked;

    // When the user presses Cancel and the write then lands
    controller.closeAuthModal();
    held.written.resolve('applied');
    // The controller waits on the write through its bridge port, and tells no fake when it saw it land.
    await untilPromisesSettled();

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

  it("As a user, I close the sign-in window's wait and start a new sign-in, and the first window's late result changes nothing on screen", async () => {
    // Given a first window round the user closed, and a second one opened after it
    const held = createHeldResults();
    const rounds: ReturnType<typeof createDeferred<SignInOutcome>>[] = [];
    const handoff: SessionHandoff = {
      signIn() {
        const round = createDeferred<SignInOutcome>();
        rounds.push(round);
        return round.promise;
      },
      signOut: () => undefined,
      signOutRead: () => Promise.resolve(),
      focus: () => undefined,
      // The first window sent its result before it heard the cancel, so the cancel ends nothing.
      cancel: () => undefined,
    };
    const { controller, auth } = startController({ handoff, applyResult: held.applyResult });
    auth.set({ tag: 'Disconnected' });
    controller.startLogin();
    controller.closeAuthModal();
    controller.startLogin();

    // When the first window's result arrives
    nth(rounds, 0).resolve({ kind: 'result', result: RESULT });
    // The controller hears the outcome through its handoff port, and tells no fake when it saw it.
    await untilPromisesSettled();

    // Then the second round's wait stays on show and the first result was never written
    expect(getAuthModalState()).toMatchObject({ open: true, view: { kind: 'window' } });
    expect(held.results).toEqual([]);
  });

  it('As a user, I close the sign-in window and am back to signed out with no error', async () => {
    // Given a sign-in window round under way
    const { handoff, changes } = startWindowRound();

    // When the window is closed
    handoff.end({ kind: 'cancelled' });
    await changes.until(() => !getAuthModalState().open);

    // Then the modal closes with no error
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
    const handoff = createFakeHandoff();
    const { controller, auth, changes } = startController({ handoff, local: true });
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
    captureExceptions();
    const handoff = createFakeHandoff();
    const { controller, auth, changes } = startController({
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

  it("As a debug panel user whose wallet could not be written here, I get a product's login request and its Sign in opens the sign-in window", async () => {
    // Given a phrase round whose result could not be written, then a product's login request
    captureExceptions();
    const handoff = createFakeHandoff();
    const { controller, auth, changes } = startController({
      handoff,
      applyResult: () => Promise.reject(new Error('The local wallet from the sign-in window could not be saved')),
    });
    auth.set({ tag: 'Disconnected' });
    controller.importPhrase();
    handoff.end({ kind: 'result', result: RESULT });
    await changes.until(() => getAuthModalState().view.kind === 'error');
    auth.set(PAIRING);

    // When the user presses the prompt's Sign in
    controller.retryLogin();

    // Then the sign-in window opened for a sign-in
    expect(handoff.signIns).toEqual(['phrase', 'signin']);
  });

  it('As a user whose sign-in window was blocked, I close the modal and press Try again and a sign-in window opens', async () => {
    // Given: a blocked phrase round whose modal the user closed
    const handoff = createFakeHandoff();
    const { controller, auth, changes } = startController({ handoff });
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

  it('As a user on a page the window refuses, I sign in and am told sign-in is not available here', async () => {
    // Given a sign-in window round under way
    const { handoff, changes } = startWindowRound();

    // When the window refuses the page
    handoff.end({ kind: 'refused' });
    await changes.until(() => getAuthModalState().view.kind === 'refused');

    // Then the modal stays open on the refused view
    expect(getAuthModalState().open).toBe(true);
  });

  it('As a user whose sign-in could not be written here, I see the error with Retry and it is reported', async () => {
    // Given a window round whose result write fails
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const exceptions = captureExceptions();
    const failure = new Error('The session from the sign-in window could not be stored');
    const { handoff, changes } = startWindowRound({ applyResult: () => Promise.reject(failure) });

    // When the result comes
    handoff.end({ kind: 'result', result: RESULT });
    await changes.until(() => getAuthModalState().view.kind === 'error');

    // Then the error shows with Retry and the failure is reported and counted under the intent
    expect(getAuthModalState()).toMatchObject({ open: true, view: { kind: 'error', retry: true } });
    expect(exceptions).toMatchObject([[failure, { step: 'session_window', tags: { reason: 'signin' } }]]);
    expect(metrics.counted('session_window.apply')).toEqual([{ outcome: 'error', reason: 'signin' }]);
    expect(metrics.counted('session_window.round')).toEqual([]);
  });

  it("As a user, I get a product's login request and see Sign in to continue with nothing opened by itself", () => {
    // Given a signed-out page with a sign-in window
    const handoff = createFakeHandoff();
    const { auth } = startController({ handoff });

    // When a product asks for a login
    auth.set(PAIRING);

    // Then the prompt shows under the product's name and no window opens
    expect(getAuthModalState()).toEqual({
      open: true,
      productLabel: 'localhost:3000',
      reason: null,
      view: { kind: 'prompt', resume: false },
    });
    expect(handoff.signIns).toEqual([]);
  });

  it('As a user shown Sign in to continue, I watch the core repeat its pairing and nothing changes on screen', () => {
    // Given the prompt on show and every later modal write recorded
    const { auth } = startController({ handoff: createFakeHandoff() });
    auth.set({ ...PAIRING, deeplink: '' });
    const writes = recordNotified(authModalState.store);

    // When: the core reports the pairing again, now with its deeplink
    auth.set(PAIRING);

    // Then nothing was written and the prompt stays
    expect(writes).toEqual([]);
    expect(getAuthModalState().view).toEqual({ kind: 'prompt', resume: false });
  });

  it("As a user asked by a product, I press Sign in and the window opens under the product's name", () => {
    // Given a product's login request on show
    const handoff = createFakeHandoff();
    const { controller, auth } = startController({ handoff });
    auth.set(PAIRING);

    // When the user presses Sign in and the core repeats its pairing
    controller.startLogin();
    auth.set(PAIRING);

    // Then: the core's pairing updates leave the waiting view alone
    expect(handoff.signIns).toEqual(['signin']);
    expect(getAuthModalState()).toMatchObject({ open: true, productLabel: 'localhost:3000', view: { kind: 'window' } });
  });

  it('As a user whose sign-in waits elsewhere, I sign in and the window opens to resume it', () => {
    // Given a signed-out page whose sign-in made elsewhere waits
    const handoff = createFakeHandoff();
    const { controller, auth } = startController({ handoff, elsewhere: () => true });
    auth.set({ tag: 'Disconnected' });

    // When the user presses Sign in
    controller.startLogin();

    // Then the window opens to resume and the waiting view shows
    expect(handoff.signIns).toEqual(['resume']);
    expect(getAuthModalState()).toMatchObject({ open: true, view: { kind: 'window' } });
  });

  it("As a user whose sign-in waits elsewhere, I get a product's login request that offers to continue it and its button resumes", () => {
    // Given a product's login request while a sign-in made elsewhere waits
    const handoff = createFakeHandoff();
    const { controller, auth } = startController({ handoff, elsewhere: () => true });
    auth.set(PAIRING);

    // When the prompt is read and its button pressed
    const prompt = getAuthModalState().view;
    controller.retryLogin();

    // Then the prompt offers to continue and the window opens to resume
    expect(prompt).toEqual({ kind: 'prompt', resume: true });
    expect(handoff.signIns).toEqual(['resume']);
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
    const handoff = createFakeHandoff();
    const { controller, calls, changes } = startController({ handoff, local: false });

    // When the user signs out and the core is asked
    controller.logout();
    const atClick = { signOuts: [...handoff.signOuts], logouts: calls.logouts };
    await changes.until(() => calls.logouts === 1);

    // Then: the window opened in the click's own turn, before the core was asked
    expect(atClick).toEqual({ signOuts: [{ notified: true }], logouts: 0 });
    expect(calls.logouts).toBe(1);
  });

  it('As a user in local mode, I sign out and the window opens without notified, then the page logs out', async () => {
    // Given a page in local mode with a sign-in window
    const handoff = createFakeHandoff();
    const { controller, calls, changes } = startController({ handoff, local: true });

    // When the user signs out
    controller.logout();
    await changes.until(() => calls.logouts === 1);

    // Then: the window, which tells the phone, opened unnotified, and the page logged out
    expect(handoff.signOuts).toEqual([{ notified: false }]);
    expect(calls.logouts).toBe(1);
  });

  it('As a user whose sign-in modal broke, I still sign in through the window and the modal stays closed', async () => {
    // Given: a broken modal island
    const exceptions = captureExceptions();
    const failure = new Error('The session from the sign-in window could not be stored');
    const handoff = createFakeHandoff();
    const { controller, auth, calls, changes } = startController({
      handoff,
      applyResult: () => Promise.reject(failure),
    });
    controller.disableAuthModal();
    auth.set({ tag: 'Disconnected' });
    controller.startLogin();

    // When: a blocked round, then a retry whose result cannot be written
    handoff.end({ kind: 'blocked' });
    await changes.until(() => getAuthModalState().view.kind === 'blocked');
    controller.startLogin();
    handoff.end({ kind: 'result', result: RESULT });
    await changes.until(() => calls.cancels === 3);

    // Then: both windows opened and the failure is reported while the modal shows nothing, since it never opened and
    // each of its three opens (two sign-ins and the failure) cancelled the core's login instead
    expect(handoff.signIns).toEqual(['signin', 'signin']);
    expect(exceptions.map(([error]) => error)).toEqual([failure]);
    expect(getAuthModalState().open).toBe(false);
    expect(getAuthModalState().view.kind).not.toBe('error');
    expect(calls.cancels).toBe(3);
  });

  it('As a user whose sign-in modal breaks while the window is open, I still sign in through the window and the modal never opens', async () => {
    // Given: a window round on show
    const held = createHeldResults();
    const { controller, handoff, calls, changes } = startWindowRound({ applyResult: held.applyResult });

    // When: the modal island breaks, then the window sends its result and it is written
    controller.disableAuthModal();
    handoff.end({ kind: 'result', result: RESULT });
    const asked = await held.asked;
    const atResult = { cancels: [...handoff.cancels], open: getAuthModalState().open };
    held.written.resolve('applied');
    await changes.until(() => held.results.length === 1);

    // Then: the round was not cancelled, its result is written, and the core's login was left alone
    expect(asked).toBe(RESULT);
    expect(atResult).toEqual({ cancels: [], open: false });
    expect(calls.cancels).toBe(0);
  });

  it('As a user whose sign-in modal broke while the window is open, I close the window and the login still ends', async () => {
    // Given a window round under way with the modal broken
    const { controller, handoff, calls, changes } = startWindowRound();
    controller.disableAuthModal();

    // When the window is closed
    handoff.end({ kind: 'cancelled' });
    await changes.until(() => calls.cancels === 1);

    // Then: a product's login waiting on the core is answered, and the page cancelled no round
    expect(calls.cancels).toBe(1);
    expect(handoff.cancels).toEqual([]);
  });

  it("As a user whose sign-in modal broke, I sign in through the window and a product's later login request still opens no modal", async () => {
    // Given a broken modal island and a window sign-in whose result was written
    const handoff = createFakeHandoff();
    const { controller, auth, calls } = startController({
      handoff,
      applyResult: () => Promise.resolve('applied'),
    });
    controller.disableAuthModal();
    auth.set({ tag: 'Disconnected' });
    controller.startLogin();
    handoff.end({ kind: 'result', result: RESULT });
    await untilPromisesSettled();

    // When a product asks for a login
    auth.set(PAIRING);
    await untilPromisesSettled();

    // Then the modal stayed closed and the core's login was cancelled instead
    expect(getAuthModalState().open).toBe(false);
    expect(calls.cancels).toBe(2);
  });
});

describe('auth controller on the page stores', () => {
  afterEach(() => {
    resetAllStoresForTests();
  });

  describe('auth controller: the auth control slot', () => {
    it.each([
      {
        member: 'startLogin',
        use: (slot: AuthControlSlot) => {
          slot.startLogin();
        },
      },
      {
        member: 'retryLogin',
        use: (slot: AuthControlSlot) => {
          slot.retryLogin();
        },
      },
      {
        member: 'importPhrase',
        use: (slot: AuthControlSlot) => {
          slot.importPhrase();
        },
      },
      {
        member: 'isValidPhrase',
        use: (slot: AuthControlSlot) => {
          slot.isValidPhrase(PHRASE);
        },
      },
      {
        member: 'importPhraseInPage',
        use: (slot: AuthControlSlot) => {
          void slot.importPhraseInPage(PHRASE);
        },
      },
      {
        member: 'logout',
        use: (slot: AuthControlSlot) => {
          slot.logout();
        },
      },
      {
        member: 'focusSignInWindow',
        use: (slot: AuthControlSlot) => {
          slot.focusSignInWindow();
        },
      },
      {
        member: 'closeAuthModal',
        use: (slot: AuthControlSlot) => {
          slot.closeAuthModal();
        },
      },
    ])(
      'As a dotli integrator, I call $member on the slot before boot and get an error that it is not filled',
      ({ use }) => {
        // Given a slot boot has not filled
        const slot = createAuthControlSlot();

        // When an island calls it
        const error = catchError(() => {
          use(slot);
        });

        // Then the slot's error is thrown
        expect(error).toEqual(new Error('Auth control used before init'));
      },
    );

    it('As a dotli integrator whose auth modal island failed before boot, I start the controller and the modal stays disabled', async () => {
      // Given the island failed first
      const slot = createAuthControlSlot();
      slot.disableModal();
      const changes = createChanges();
      const { commands, calls } = recordCommands({ changes });

      // When boot starts the controller and a login asks for the modal
      const opened = slot.init(buildInitParams(commands)).openAuthModal();
      await changes.until(() => calls.cancels === 1);

      // Then the modal stays shut and the login is cancelled instead
      expect(opened).toBe(false);
      expect(calls.cancels).toBe(1);
    });

    it('As a dotli integrator, I reset the page stores and the slot empties while the next controller boot shows the modal again', () => {
      // Given a filled slot whose modal an island disabled
      const slot = createAuthControlSlot();
      slot.disableModal();
      const { commands } = recordCommands({ changes: createChanges() });
      slot.init(buildInitParams(commands));

      // When the stores reset, an island calls the slot and boot fills it again
      resetAllStoresForTests();
      const error = catchError(() => {
        slot.startLogin();
      });
      const opened = slot.init(buildInitParams(commands)).openAuthModal();

      // Then the emptied slot threw, and the new controller presents the modal
      expect(error).toEqual(new Error('Auth control used before init'));
      expect(opened).toBe(true);
    });

    it('As a dotli integrator, I start the controller again while a login runs and its later failure leaves the new modal closed and the prompts free', async () => {
      // Given a slot whose controller has a login under way on the page's coordinator
      captureExceptions();
      const coordinator = createBlockingModalCoordinator();
      const pending = createDeferred<LoginOutcome>();
      const failing: AuthCommands = {
        login: () => pending.promise,
        logout: () => Promise.resolve({ phone: 'told' as const }),
        cancelLogin: () => undefined,
      };
      const slot = createAuthControlSlot();
      slot.init(buildInitParams(failing, coordinator));
      authState.set({ tag: 'Disconnected' });
      slot.startLogin();
      await untilPromisesSettled();

      // When boot starts the controller again and the first login then fails
      const { commands } = recordCommands({ changes: createChanges() });
      slot.init(buildInitParams(commands, coordinator));
      pending.reject(new Error('The paired session could not be stored'));
      await untilPromisesSettled();
      let promptShown = false;
      void coordinator.createScope().enqueue(() => {
        promptShown = true;
        return Promise.resolve();
      });
      await untilPromisesSettled();

      // Then the modal is closed and the next prompt showed
      expect(getAuthModalState().open).toBe(false);
      expect(promptShown).toBe(true);
    });
  });

  describe('auth controller: the topbar sign-in', () => {
    it('As a user on a product page, I sign in from the topbar and the host opens its host-global login', async () => {
      // Given a booted page with a product loaded
      const changes = createChanges();
      const { commands, calls } = recordCommands({ changes });
      authControl.init(buildInitParams(commands));
      authState.set({ tag: 'Disconnected' });
      productState.setLoaded({ label: 'localhost:3000', productId: asProductId('localhost:3000') });

      // When the topbar signs in
      authControl.startLogin();
      await changes.until(() => calls.logins.length === 1);

      // Then the modal names no product and the core was asked
      expect(getAuthModalState().productLabel).toBeNull();
      expect(calls.logins).toEqual([undefined]);
    });

    it('As a user on the error view, I retry from the topbar and a retry that fails the same way shows the error again', () => {
      // Given a booted page whose login failed, and a retry from the topbar
      const { commands } = recordCommands({ changes: createChanges() });
      authControl.init(buildInitParams(commands));
      const failed = { tag: 'LoginFailed', kind: 'Other', reason: 'worker init failed' } as const;
      authState.set(failed);
      authControl.startLogin();
      const retryView = getAuthModalState().view;

      // When the core reports the same failure again
      authState.set(failed);

      // Then the spinner showed for the retry, and the error shows again
      expect(retryView).toEqual({ kind: 'spinner' });
      expect(getAuthModalState().view).toMatchObject({ kind: 'error', message: 'worker init failed' });
    });
  });
});
