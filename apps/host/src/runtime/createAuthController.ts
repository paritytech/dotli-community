// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-in modal's state machine, which writes the page's modal store. Imports no Solid and loads eagerly because
// auth states arrive from boot, before any modal view mounts. The controller owns the modal and picks one sign-in route
// per surface: the sign-in window's on a page that has one, or the page's own, which pairs in place on the core in the
// bridge chunk, reached through its `bridge` port. The route's round is a nested value of the machine's state.

import { withActiveTld } from '@dotli/config';
import { createReporter, defineCount } from '@dotli/metrics';
import {
  createStateMachine,
  getErrorMessage,
  log,
  nest,
  registerStoreStateReset,
  type HandlerOf,
  type Transition,
} from '@dotli/shared';
import type { LoginFailureKind } from '@parity/truapi-host';
import type { ReadableAtom } from 'nanostores';
import type { LoginOutcome, LoginParams } from './createAuthCommands.js';
import type { LogoutOutcome } from './createPageSignOut.js';
import type { HostBridge } from './bridge.js';
import type { BlockingModalCoordinator } from './createBlockingModalCoordinator.js';
import { createInPageSignIn } from './createInPageSignIn.js';
import { authViews, type LoginStep } from './session/authViews.js';
import type { DotliAuthState } from './session/types.js';
import type { SessionHandoff } from './sessionHandoff/createSessionHandoff.js';
import {
  getLeaseScope,
  getRound,
  getShownPhrase,
  isLeaseDisabled,
  isLeaseHeld,
  isPhraseRound,
  isWaiting,
  releaseLeaseHold,
  type AuthModalEvent,
  type AuthModalMachine,
  type AuthModalPort,
  type CloseAuthModalParams,
  type InPagePhrase,
  type LiveLease,
  type OpenAuthModalParams,
  type SignInRoundMachine,
  type StartLoginParams,
} from './signInRoute.js';
import { authState, type AuthState } from './state/authState.js';
import { sessionElsewhereState } from './state/sessionElsewhereState.js';
import { walletModeState } from './state/walletModeState.js';
import { createWindowSignIn } from './createWindowSignIn.js';
import { authModalState, type AuthModalView } from '../state/authModalState.js';
import { getLoginFailureView } from './getLoginFailureView.js';
import { rereadBeforeSignIn } from './rereadBeforeSignIn.js';
import type { toEntropy } from './recoveryPhrase.js';
import { reportLocalWalletFailure } from './walletFailure.js';

const report = createReporter({ flow: 'wallet' });

/**
 * Count. A sign-in command threw after the bridge chunk loaded. Tagged `outcome` (error), `reason` (the error's
 * name) and `step` (`login, logout, cancel_login`).
 */
const authCommandMetric = defineCount<'error'>('auth.command');

/**
 * Count. The sign-in modal's lease failed other than by its own abort. Tagged `outcome` (error) and `reason` (the
 * error's name).
 */
const authModalLeaseMetric = defineCount<'error'>('auth.modal_lease');

/** Count. A transition of the sign-in modal's machine threw. Tagged `outcome` (error) and `reason` (the error's name). */
const authModalTransitionMetric = defineCount<'error'>('auth_modal.transition');

/** The page's sign-in and sign-out on its core. */
export type AuthCommands = {
  /**
   * Answers how the login ended. A click queued behind a login shares its answer. Answers `paired` at once for a user
   * already signed in. Rejects when the core paired but its session could not be stored or read back. A call queued
   * behind a login that rejects rejects too, with that failure as its cause.
   */
  login(params?: LoginParams): Promise<LoginOutcome>;
  /**
   * Settles once the sign-out has ended, with whether the phone heard of every session this page held. A failed
   * sign-out is reported and never rejects.
   */
  logout(): Promise<LogoutOutcome>;
  /**
   * Stops the pairing under way, at once and outside the queue, and ends the login round, so a later click logs in.
   * Never throws.
   */
  cancelLogin(): void;
};

/** What the controller reaches in the bridge chunk. */
type AuthBridge = Pick<HostBridge, 'authCommands' | 'applyWindowResult' | 'rereadSession'> & {
  walletSwitch: Pick<HostBridge['walletSwitch'], 'useLocalWallet'>;
};

type Params = {
  coordinator: BlockingModalCoordinator;
  /**
   * The bridge chunk, awaited per intent, so an intent issued before the chunk loads still runs. Rejects when the
   * chunk fails to load.
   */
  bridge: () => Promise<AuthBridge>;
  /** The current auth step, read for each intent. */
  auth: ReadableAtom<DotliAuthState>;
  /** Hears every auth step, an equal one included, which the controller follows until it is disposed. */
  subscribeAuthSteps: AuthState['subscribeSteps'];
  /** The sign-in window, or null for a page that pairs in place. */
  handoff: SessionHandoff | null;
  /** Whether the page runs on a local wallet now. Never throws. */
  isLocalWallet: () => boolean;
  /**
   * Loads the recovery phrase check, the first time a page with no window asks for a phrase. Rejects when its chunk
   * fails to load.
   */
  loadRecoveryPhrase: () => Promise<{ toEntropy: typeof toEntropy }>;
  /** Whether the page shows signed out while a sign-in made elsewhere waits, which a sign-in then resumes. */
  elsewhere: () => boolean;
};

/** What the slot's `init` takes: the controller's params, less the page stores the slot reads itself. */
type InitParams = Omit<Params, 'auth' | 'subscribeAuthSteps' | 'isLocalWallet' | 'elsewhere'>;

type LiveKind = LiveLease['kind'];

/** The events of the route's round, which the round's own handlers take. */
type RoundEventKind = 'windowEnded' | 'resultWritten' | 'resultFailed' | 'phraseLoaded' | 'phraseMissed';

type RunCommandParams = {
  bridge: Params['bridge'];
  step: 'login' | 'logout' | 'cancel_login';
  run: (commands: AuthCommands) => unknown;
  update: Transition<AuthModalMachine>['update'];
};

export type AuthController = ReturnType<typeof createAuthController>;

/** The modal's steps the controller's handlers and its route share. */
export type ModalSteps = ReturnType<typeof createModalSteps>;

/** Returns the controller of the page's sign-in modal, which follows the auth steps until it is disposed. */
export function createAuthController({
  coordinator,
  bridge,
  auth,
  subscribeAuthSteps,
  handoff,
  isLocalWallet,
  loadRecoveryPhrase,
  elsewhere,
}: Params) {
  const steps = createModalSteps({ coordinator, bridge });

  /** Loads the phrase check and the bridge together. Rejects when either fails to load. */
  async function loadInPagePhrase(): Promise<InPagePhrase> {
    const [phraseCheck, { walletSwitch }] = await Promise.all([loadRecoveryPhrase(), bridge()]);
    return { toEntropy: phraseCheck.toEntropy, useLocalWallet: entropy => walletSwitch.useLocalWallet(entropy) };
  }

  /** Reads the saved session again and settles once the page shows it. Rejects when the bridge chunk fails to load. */
  async function rereadSession(): Promise<void> {
    await (await bridge()).rereadSession();
  }

  const route =
    handoff === null
      ? createInPageSignIn({ inPagePhrase: loadInPagePhrase, modal: steps })
      : createWindowSignIn({
          handoff,
          applyResult: async result => (await bridge()).applyWindowResult(result),
          elsewhere,
          isLocalWallet,
          modal: steps,
        });

  /** Takes the modal off screen and ends the route's round, cancelling the core's login unless `params` says not to. */
  function close(
    state: LiveLease,
    { skipTruapiCancel, cancel = 'page' }: CloseAuthModalParams,
    transition: Transition<AuthModalMachine>,
  ): void {
    switch (state.kind) {
      case 'closed':
      case 'queued':
      case 'open':
        transition.emitState({ kind: 'closed', round: { kind: 'idle' } });
        break;
      case 'disabled':
        // A disabled lease stays disabled, so a close never brings back a broken modal island.
        transition.emitState({ kind: 'disabled', round: { kind: 'idle' } });
        break;
    }
    route.end(cancel);
    releaseLease(state);
    if (skipTruapiCancel !== true) {
      // A user close stops the core's pairing poll, which then resolves as Rejected.
      steps.cancelLogin(transition);
    }
  }

  const openModal: HandlerOf<AuthModalMachine, LiveKind, 'opened'> = (state, { params }, transition) => {
    steps.open(state, params, transition);
  };
  const askLogin: HandlerOf<AuthModalMachine, LiveKind, 'loginAsked'> = (state, event, transition) => {
    if (authViews.getSignedInSession(auth.get()) !== null) {
      return;
    }
    route.startLogin(state, event, transition);
  };
  const commandLogin: HandlerOf<AuthModalMachine, LiveKind, 'loginCommanded'> = (_state, { reason }, transition) => {
    steps.login({ reason }, transition);
  };
  const closeModal: HandlerOf<AuthModalMachine, LiveKind, 'closeAsked'> = (state, { params }, transition) => {
    close(state, params, transition);
  };
  const disableModal: HandlerOf<AuthModalMachine, LiveKind, 'disableAsked'> = (state, _event, transition) => {
    if (!isLeaseHeld(state)) {
      transition.emitState({ kind: 'disabled', round: state.round });
      return;
    }
    // The route's wait goes on and its own outcome ends the core's login, so only the modal is released.
    if (isWaiting(state.round)) {
      transition.emitState({ kind: 'disabled', round: state.round });
      releaseLease(state);
      return;
    }
    transition.emitState({ kind: 'disabled', round: { kind: 'idle' } });
    route.end('page');
    releaseLease(state);
    steps.cancelLogin(transition);
  };
  const disposeModal: HandlerOf<AuthModalMachine, LiveKind, 'disposeAsked'> = (state, _event, { emitState }) => {
    emitState({ kind: 'disposed' });
    unlisten();
    route.end('page');
    releaseLease(state);
  };
  const logOut: HandlerOf<AuthModalMachine, LiveKind, 'logoutAsked'> = (_state, _event, { update }) => {
    // The route's sign-out window opens first, before any wait, since a browser opens a window only in the click's
    // own turn. The signed-in flag is not the controller's to write.
    route.signOut();
    // With the bridge loaded, as on any signed-in page, this runs in the click's continuation, so a paired page reads
    // its copy before the window's document loads.
    runCommand({ bridge, step: 'logout', run: commands => commands.logout(), update });
  };
  const focusWindow: HandlerOf<AuthModalMachine, LiveKind, 'focusAsked'> = () => {
    route.focus();
  };
  /** `Disconnected` leaves the modal alone, so an unrelated disconnect never closes an active pairing. */
  const followAuthStep: HandlerOf<AuthModalMachine, LiveKind, 'authStepped'> = (
    state,
    { state: authStep, wasSignedIn },
    transition,
  ) => {
    const step = authViews.getLoginStep(authStep);
    transition.emitSideEffect({ kind: 'authLogged', tag: authStep.tag, failure: getFailureKind(step) });
    // A phrase the user is typing stays on show. The core's login waits behind it, and the modal's Cancel ends both.
    if (step !== null && isLeaseHeld(state) && steps.getViewKind() === 'phrase') {
      return;
    }
    if (authViews.getSignedInSession(authStep) !== null) {
      // Only becoming signed in counts, so a session the core reports again leaves a phrase round started while signed
      // in open. The route's wait goes on until its own outcome, so closing the modal now would lose that outcome.
      if (wasSignedIn || isWaiting(state.round)) {
        return;
      }
      // A sign-in by another route ends a sign-in the page still waits on, such as a blocked window's.
      close(state, { skipTruapiCancel: true, cancel: 'signed_in' }, transition);
      return;
    }
    switch (step?.step) {
      case 'pairing':
        route.pairing(state, step.pairing, transition);
        return;
      case 'authenticating':
        // The core's own states must not cover the route's wait.
        if (!isWaiting(state.round)) {
          steps.show({ kind: 'authenticating' });
        }
        return;
      case 'failed':
        if (!isWaiting(state.round)) {
          steps.showFailure(state, { failure: step.kind, reason: step.reason }, transition);
        }
        return;
      case undefined:
        return;
    }
  };
  /** Puts the modal on screen once the queue grants its lease, unless the scope was replaced or disposed meanwhile. */
  const grantLease: HandlerOf<AuthModalMachine, 'queued', 'leaseGranted'> = (
    state,
    { scope, signal, release },
    { emitState },
  ) => {
    if (scope !== state.scope || signal.aborted) {
      release();
      return;
    }
    // A scope disposed while the modal is open frees the queue with no event.
    function finish(): void {
      signal.removeEventListener('abort', finish);
      release();
    }
    signal.addEventListener('abort', finish, { once: true });
    emitState({ kind: 'open', round: state.round, scope, release: finish });
    authModalState.update({ open: true });
  };
  /** A lease granted to a modal that no longer waits for one is given back at once. */
  const refuseLease: HandlerOf<AuthModalMachine, 'closed' | 'open' | 'disabled', 'leaseGranted'> = (
    _state,
    { release },
  ) => {
    release();
  };
  const handleRound = nest<AuthModalMachine, LiveKind, SignInRoundMachine, RoundEventKind>({
    find: (state, event) => (event.round === state.round ? state.round : null),
    store: (state, _event, round) => ({ ...state, round }),
    handlers: route.rounds,
  });

  const machine = createStateMachine<AuthModalMachine>({
    initial: { kind: 'closed', round: { kind: 'idle' } },
    handlers: {
      closed: {
        opened: openModal,
        loginAsked: askLogin,
        loginCommanded: commandLogin,
        phraseAsked: route.importPhrase,
        closeAsked: closeModal,
        disableAsked: disableModal,
        disposeAsked: disposeModal,
        logoutAsked: logOut,
        focusAsked: focusWindow,
        authStepped: followAuthStep,
        leaseGranted: refuseLease,
        failureShown: steps.showFailure,
        windowEnded: handleRound,
        resultWritten: handleRound,
        resultFailed: handleRound,
        phraseLoaded: handleRound,
        phraseMissed: handleRound,
      },
      queued: {
        opened: openModal,
        loginAsked: askLogin,
        loginCommanded: commandLogin,
        phraseAsked: route.importPhrase,
        closeAsked: closeModal,
        disableAsked: disableModal,
        disposeAsked: disposeModal,
        logoutAsked: logOut,
        focusAsked: focusWindow,
        authStepped: followAuthStep,
        leaseGranted: grantLease,
        failureShown: steps.showFailure,
        windowEnded: handleRound,
        resultWritten: handleRound,
        resultFailed: handleRound,
        phraseLoaded: handleRound,
        phraseMissed: handleRound,
      },
      open: {
        opened: openModal,
        loginAsked: askLogin,
        loginCommanded: commandLogin,
        phraseAsked: route.importPhrase,
        closeAsked: closeModal,
        disableAsked: disableModal,
        disposeAsked: disposeModal,
        logoutAsked: logOut,
        focusAsked: focusWindow,
        authStepped: followAuthStep,
        leaseGranted: refuseLease,
        failureShown: steps.showFailure,
        windowEnded: handleRound,
        resultWritten: handleRound,
        resultFailed: handleRound,
        phraseLoaded: handleRound,
        phraseMissed: handleRound,
      },
      disabled: {
        opened: openModal,
        loginAsked: askLogin,
        loginCommanded: commandLogin,
        phraseAsked: route.importPhrase,
        closeAsked: closeModal,
        disableAsked: disableModal,
        disposeAsked: disposeModal,
        logoutAsked: logOut,
        focusAsked: focusWindow,
        authStepped: followAuthStep,
        leaseGranted: refuseLease,
        failureShown: steps.showFailure,
        windowEnded: handleRound,
        resultWritten: handleRound,
        resultFailed: handleRound,
        phraseLoaded: handleRound,
        phraseMissed: handleRound,
      },
      disposed: null,
    },
    onEffect: ({ tag, failure }) => {
      report.log.event('auth state', { state: tag, ...(failure === null ? {} : { kind: failure }) });
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: authModalTransitionMetric,
        message: '[dot.li auth] A sign-in modal transition threw',
      });
    },
  });

  let lastSignedIn = authViews.getSignedInSession(auth.get()) !== null;
  const unlisten = subscribeAuthSteps(state => {
    const wasSignedIn = lastSignedIn;
    lastSignedIn = authViews.getSignedInSession(state) !== null;
    machine.update({ kind: 'authStepped', state, wasSignedIn });
  });

  const modal: AuthModalPort = {
    getLease: () => getLeaseScope(machine.state.get()),
    show: steps.show,
  };

  function openAuthModal(params: OpenAuthModalParams = {}): boolean {
    machine.update({ kind: 'opened', params });
    return isLeaseHeld(machine.state.get());
  }

  function startLogin(params: StartLoginParams = {}): void {
    // A pairing writes its session to the shared store, so one started while the store is down would be lost.
    if (authViews.isSessionUnreachable(auth.get())) {
      void rereadBeforeSignIn({
        open: () => openAuthModal({ reason: params.reason, label: params.label }),
        modal,
        rereadSession,
        auth,
        proceed:
          handoff === null
            ? () => {
                machine.update({ kind: 'loginCommanded', reason: params.reason });
              }
            : null,
        elsewhere,
      });
      return;
    }
    machine.update({ kind: 'loginAsked', params });
  }

  function importPhrase(): void {
    if (authViews.isSessionUnreachable(auth.get())) {
      void rereadBeforeSignIn({
        open: () => openAuthModal(),
        modal,
        rereadSession,
        auth,
        proceed:
          handoff === null
            ? () => {
                machine.update({ kind: 'phraseAsked' });
              }
            : null,
        elsewhere,
      });
      return;
    }
    machine.update({ kind: 'phraseAsked' });
  }

  return {
    /**
     * Opens the sign-in window and waits for it, asking it to resume a sign-in made elsewhere when one waits, or with
     * no window opens the modal and asks the core to log in. Does nothing while a login is already on show or the user
     * is signed in. The window opens before this returns, so a click handler reaches it with no wait between. While the
     * saved session cannot be reached, reads it again first, and then signs in, asks for a click to open the window, or
     * says why it cannot. Never throws.
     */
    startLogin,
    /**
     * Opens the sign-in window at its recovery phrase view and waits for it, or with no window opens the modal at its
     * phrase view. Also runs for a signed-in user, who replaces the local wallet. While the saved session cannot be
     * reached, reads it again first, and then goes on, asks for a click to open the window, or says why it cannot.
     * Never throws.
     */
    importPhrase,
    /** Whether the modal's phrase view takes `phrase`. Never throws. */
    isValidPhrase(phrase: string): boolean {
      const round = getRound(machine.state.get());
      return round !== null && (getShownPhrase(round)?.toEntropy(phrase) ?? null) !== null;
    },
    /**
     * Uses the wallet of a phrase the modal's phrase view took, which reloads the page. Rejects in these cases:
     * - the wallet could not be saved, which the switch reported
     * - the phrase import has not loaded, which is reported here
     * - the controller was disposed, which is reported here
     * - the phrase is not valid, which is the user's input and goes unreported
     */
    async importPhraseInPage(phrase: string): Promise<void> {
      const round = getRound(machine.state.get());
      if (round === null) {
        // A disposed controller shows no phrase view, so a call here is a fault of the page and not of the input.
        const error = new Error('The sign-in controller was disposed');
        reportLocalWalletFailure(error, 'phrase-load');
        throw error;
      }
      const loaded = getShownPhrase(round);
      if (loaded === null) {
        // The phrase view shows only once its check loaded, so this is a fault of the page and not of the input.
        const error = new Error('The recovery phrase import was not loaded');
        reportLocalWalletFailure(error, 'phrase-load');
        throw error;
      }
      const entropy = loaded.toEntropy(phrase);
      if (entropy === null) {
        throw new Error('Not a valid recovery phrase');
      }
      if ((await loaded.useLocalWallet(entropy)) === 'failed') {
        throw new Error('The recovery phrase wallet could not be saved');
      }
    },
    /**
     * The modal's Retry, Try again and Sign in. Asks for the recovery phrase again after a phrase round on show, else
     * starts a sign-in. Never throws.
     */
    retryLogin(): void {
      const round = getRound(machine.state.get());
      if (round === null) {
        return;
      }
      if (isPhraseRound(round)) {
        importPhrase();
      } else {
        startLogin();
      }
    },
    /** Opens the sign-out window before this returns, then asks the core to log out. Never throws. */
    logout(): void {
      machine.update({ kind: 'logoutAsked' });
    },
    /** Brings the sign-in window of the open round to the front. Never throws. */
    focusSignInWindow(): void {
      machine.update({ kind: 'focusAsked' });
    },
    /**
     * Opens the modal and returns true, or returns false when the modal is disabled, having cancelled the login, and
     * returns false after dispose, cancelling nothing.
     */
    openAuthModal,
    /** Closes the modal, cancelling the login it showed unless `params` says not to. Never throws. */
    closeAuthModal(params: CloseAuthModalParams = {}): void {
      machine.update({ kind: 'closeAsked', params });
    },
    /**
     * For when the auth-modal island failed. A login would otherwise hold the blocking-modal lease for a modal nobody
     * can close, stalling every later prompt. A sign-in window already open still signs in. Never throws.
     */
    disableAuthModal(): void {
      machine.update({ kind: 'disableAsked' });
    },
    /**
     * Stops following the auth state and closes the modal without cancelling a login. Every later call does nothing,
     * and a login it left running opens no modal. Never throws.
     */
    dispose(): void {
      machine.update({ kind: 'disposeAsked' });
    },
  };
}

/** Builds the modal's steps. A step that moves the modal takes the transition it runs in, and none reaches the machine. */
function createModalSteps({ coordinator, bridge }: Pick<Params, 'coordinator' | 'bridge'>) {
  /**
   * Opens the modal and returns the lease it leaves, queued for the screen when it was closed. Returns null when the
   * modal is disabled, having cancelled the core's login.
   */
  function open(
    state: LiveLease,
    { reason, label, dotSuffix }: OpenAuthModalParams,
    transition: Transition<AuthModalMachine>,
  ): LiveLease | null {
    if (isLeaseDisabled(state)) {
      cancelLogin(transition);
      return null;
    }
    // A "localhost:<port>" label is a local dev server in localhost-proxy mode, shown as-is.
    let productLabel: string | null = null;
    if (label !== undefined && label.length > 0) {
      productLabel = label.startsWith('localhost:') || dotSuffix === false ? label : withActiveTld(label);
    }
    authModalState.update({
      productLabel,
      reason: reason !== undefined && reason.length > 0 ? reason : null,
      view: { kind: 'spinner' },
    });
    if (isLeaseHeld(state)) {
      return state;
    }
    const scope = coordinator.createScope();
    const queued: LiveLease = { kind: 'queued', round: state.round, scope };
    transition.emitState(queued);
    void scope
      .enqueue(
        signal =>
          new Promise<void>(resolve => {
            transition.update({ kind: 'leaseGranted', scope, signal, release: resolve });
          }),
      )
      .catch((error: unknown) => {
        // Closing the modal disposes its lease, which rejects with an AbortError.
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          report.defect(error, {
            step: 'auth_modal_lease',
            metric: authModalLeaseMetric,
            message: '[dot.li auth] authentication modal lease failed:',
          });
        }
      });
    return queued;
  }

  /** Asks the core to log in. A failure opens the modal at the error view. */
  function login(params: LoginParams, { update }: Transition<AuthModalMachine>): void {
    runCommand({ bridge, step: 'login', run: commands => commands.login(params), update });
  }

  /** Cancels the core's login. */
  function cancelLogin({ update }: Transition<AuthModalMachine>): void {
    runCommand({
      bridge,
      step: 'cancel_login',
      run: commands => {
        commands.cancelLogin();
      },
      update,
    });
  }

  /** Opens the modal at the error view of a failed sign-in. */
  function showFailure(
    state: LiveLease,
    { failure, reason }: Pick<Extract<AuthModalEvent, { kind: 'failureShown' }>, 'failure' | 'reason'>,
    transition: Transition<AuthModalMachine>,
  ): void {
    if (open(state, {}, transition) === null) {
      return;
    }
    authModalState.update({ view: getLoginFailureView(failure, reason) });
  }

  /** Shows `view` in the modal. Never throws. */
  function show(view: AuthModalView): void {
    authModalState.update({ view });
  }

  /** Returns the kind of the view on show. Never throws. */
  function getViewKind(): AuthModalView['kind'] {
    return authModalState.store.get().view.kind;
  }

  return { open, show, getViewKind, login, cancelLogin, showFailure };
}

/**
 * Runs a sign-in command once the bridge chunk loads, as work of the machine. The work reports its own failure, then
 * answers a failed login as `failureShown` and anything else as `commandEnded`.
 */
function runCommand({ bridge, step, run, update }: RunCommandParams): void {
  const message = `[dot.li auth] ${step} failed:`;

  function getFailedEvent(error: unknown): AuthModalEvent {
    return step === 'login'
      ? { kind: 'failureShown', failure: 'Other', reason: getErrorMessage(error) }
      : { kind: 'commandEnded' };
  }

  update(
    bridge().then(
      loaded =>
        Promise.resolve()
          .then(() => run(loaded.authCommands))
          .then(
            (): AuthModalEvent => ({ kind: 'commandEnded' }),
            (error: unknown) => {
              report.defect(error, { step, metric: authCommandMetric, message, attributes: { step } });
              return getFailedEvent(error);
            },
          ),
      // The getter resolves to the chunk boot already awaited, so a failure here is a wiring fault boot reported first.
      (error: unknown) => {
        log.error(message, error);
        return getFailedEvent(error);
      },
    ),
  );
}

/** Takes the modal off screen and gives up `held`, a lease its handler already moved on from. */
function releaseLease(held: LiveLease): void {
  releaseLeaseHold(held);
  authModalState.reset();
}

/** The core's failure kind of a login step, or null when the step is not a failure. */
function getFailureKind(step: LoginStep | null): LoginFailureKind | null {
  switch (step?.step) {
    case 'failed':
      return step.kind;
    case 'pairing':
    case 'authenticating':
    case undefined:
      return null;
  }
}

/**
 * Builds the slot that holds a page's auth controller, which every member but `init` and `disableModal` needs. A store
 * reset disposes the controller and empties the slot.
 */
export function createAuthControlSlot() {
  let controller: AuthController | null = null;
  // An island can fail to hydrate before boot starts the controller.
  let modalBroken = false;

  registerStoreStateReset(() => {
    controller?.dispose();
    controller = null;
    modalBroken = false;
  });

  function requireController(): AuthController {
    if (controller === null) {
      throw new Error('Auth control used before init');
    }
    return controller;
  }

  function init(params: InitParams): AuthController {
    controller?.dispose();
    const started = createAuthController({
      ...params,
      auth: authState.store,
      subscribeAuthSteps: authState.subscribeSteps,
      isLocalWallet: walletModeState.isLocal,
      elsewhere: () => sessionElsewhereState.store.get(),
    });
    if (modalBroken) {
      started.disableAuthModal();
    }
    controller = started;
    return started;
  }

  function startLogin(): void {
    requireController().startLogin();
  }

  function retryLogin(): void {
    requireController().retryLogin();
  }

  function importPhrase(): void {
    requireController().importPhrase();
  }

  function isValidPhrase(phrase: string): boolean {
    return requireController().isValidPhrase(phrase);
  }

  function importPhraseInPage(phrase: string): Promise<void> {
    return requireController().importPhraseInPage(phrase);
  }

  function logout(): void {
    requireController().logout();
  }

  function focusSignInWindow(): void {
    requireController().focusSignInWindow();
  }

  function closeAuthModal(params: CloseAuthModalParams = {}): void {
    requireController().closeAuthModal(params);
  }

  function disableModal(): void {
    modalBroken = true;
    controller?.disableAuthModal();
  }

  return {
    /**
     * Starts the controller over the page's stores, disposing the one started before, and returns it. A modal disabled
     * before stays disabled.
     */
    init,
    /** Starts a sign-in with no reason or label. Throws before `init`. */
    startLogin,
    /** The modal's Retry, Try again and Sign in. Throws before `init`. */
    retryLogin,
    /** Asks for a recovery phrase. Throws before `init`. */
    importPhrase,
    /** Whether the modal's phrase view takes `phrase`. Throws before `init`. */
    isValidPhrase,
    /**
     * Uses the wallet of a phrase the modal's phrase view took. Throws before `init`. Rejects when the wallet could not
     * be saved, when the phrase import has not loaded, or when the phrase is not valid.
     */
    importPhraseInPage,
    /** Opens the sign-out window, then logs out. Throws before `init`. */
    logout,
    /** Brings the sign-in window of the open round to the front. Throws before `init`. */
    focusSignInWindow,
    /** Closes the modal, cancelling the login it showed unless `params` says not to. Throws before `init`. */
    closeAuthModal,
    /**
     * For when the auth-modal island failed. Disables the modal now and for every controller `init` starts later, and
     * works before `init`.
     */
    disableModal,
  };
}

/** The page's auth controller, for islands that hydrate on their own and so cannot be handed one. */
export const authControl = createAuthControlSlot();
