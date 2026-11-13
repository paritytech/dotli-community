// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-in modal's state machine, which writes the page's modal store. Imports no Solid and loads eagerly because
// auth states arrive from boot, before any modal view mounts. The controller owns the modal and picks one sign-in route
// per surface: the sign-in window's on a page that has one, or the page's own, which pairs in place on the core in the
// bridge chunk, reached through its `bridge` port. The route's round is a nested value of the machine's state.

import { createReporter, defineCount } from '@dotli/metrics';
import { createStateMachine, log, nest, type HandlerOf, type Transition } from '@dotli/shared';
import type { LoginFailureKind } from '@parity/truapi-host';
import type { ReadableAtom } from 'nanostores';
import type { HostBridge } from './bridge.js';
import { createModalSteps, showView } from './authModalSteps.js';
import type { BlockingModalCoordinator, BlockingModalScope } from './createBlockingModalCoordinator.js';
import { createInPageSignIn } from './createInPageSignIn.js';
import { authViews, type LoginStep } from './session/authViews.js';
import type { DotliAuthState } from './session/types.js';
import type { SessionHandoff } from './sessionHandoff/createSessionHandoff.js';
import {
  getRound,
  getShownPhrase,
  isLeaseDisabled,
  isLeaseHeld,
  isPhraseRound,
  isWaiting,
  releaseLeaseHold,
  type AuthModalEvent,
  type AuthModalMachine,
  type CloseAuthModalParams,
  type InPagePhrase,
  type LiveModal,
  type ModalLease,
  type OpenAuthModalParams,
  type SignInRound,
  type SignInRoundMachine,
  type StartLoginParams,
} from './signInRoute.js';
import type { AuthState } from './state/authState.js';
import { createWindowSignIn } from './createWindowSignIn.js';
import { authModalState, type AuthModalView } from '../state/authModalState.js';
import type { toEntropy } from './recoveryPhrase.js';
import { reportLocalWalletFailure } from './walletFailure.js';
import { runAuthCommand } from './runAuthCommand.js';

const report = createReporter({ flow: 'wallet' });

/**
 * Count. The sign-in modal's lease failed other than by its own abort. Tagged `outcome` (error) and `reason` (the
 * error's name).
 */
const authModalLeaseMetric = defineCount<'error'>('auth.modal_lease');

/** Count. A transition of the sign-in modal's machine threw. Tagged `outcome` (error) and `reason` (the error's name). */
const authModalTransitionMetric = defineCount<'error'>('auth_modal.transition');

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

const UNREACHABLE_VIEW: AuthModalView = {
  kind: 'error',
  message: 'The saved session cannot be read',
  retry: true,
  pending: false,
  title: "Can't reach your saved sign-in",
  subtitle: 'dot.li could not check whether you are signed in. Try again in a moment.',
};

/** The events of the route's round, which the round's own handlers take. */
type RoundEventKind = 'windowEnded' | 'resultWritten' | 'resultFailed' | 'phraseLoaded' | 'phraseMissed';

export type AuthController = ReturnType<typeof createAuthController>;

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
  const modalSteps = createModalSteps({
    coordinator,
    runCommand: command => runAuthCommand(command, async () => (await bridge()).authCommands),
  });

  /** Loads the phrase check and the bridge together. Rejects when either fails to load. */
  async function loadInPagePhrase(): Promise<InPagePhrase> {
    const [phraseCheck, { walletSwitch }] = await Promise.all([loadRecoveryPhrase(), bridge()]);
    return { toEntropy: phraseCheck.toEntropy, useLocalWallet: entropy => walletSwitch.useLocalWallet(entropy) };
  }

  const route =
    handoff === null
      ? createInPageSignIn({ inPagePhrase: loadInPagePhrase, modal: modalSteps })
      : createWindowSignIn({
          handoff,
          applyResult: async result => (await bridge()).applyWindowResult(result),
          elsewhere,
          isLocalWallet,
          modal: modalSteps,
        });

  const handleRound = nest<AuthModalMachine, 'live', SignInRoundMachine, RoundEventKind>({
    find: (state, event) => (event.round === state.round ? state.round : null),
    store: (state, _event, round) => ({ ...state, round }),
    handlers: route.rounds,
  });

  /**
   * Starts a sign-in, or while the saved session cannot be reached reads it again first, since a pairing started while
   * the store is down would lose its session.
   */
  const askLogin: HandlerOf<AuthModalMachine, 'live', 'loginAsked'> = (state, event, transition) => {
    const { reason, label } = event.params;
    if (authViews.isSessionUnreachable(state.auth)) {
      const opened = modalSteps.open(state, { reason, label }, transition);
      if (opened !== null) {
        startReread(opened, { kind: 'rereading', asked: 'login', reason }, transition);
      }
      return;
    }
    if (authViews.getSignedInSession(state.auth) !== null) {
      return;
    }
    route.startLogin(state, event, transition);
  };
  /** Asks for a recovery phrase, or while the saved session cannot be reached reads it again first. */
  const askPhrase: HandlerOf<AuthModalMachine, 'live', 'phraseAsked'> = (state, event, transition) => {
    if (authViews.isSessionUnreachable(state.auth)) {
      const opened = modalSteps.open(state, {}, transition);
      if (opened !== null) {
        startReread(opened, { kind: 'rereading', asked: 'phrase', reason: undefined }, transition);
      }
      return;
    }
    route.importPhrase(state, event, transition);
  };

  const machine = createStateMachine<AuthModalMachine>({
    initial: {
      kind: 'live',
      lease: { kind: 'closed' },
      round: { kind: 'idle' },
      auth: auth.get(),
      view: { kind: 'spinner' },
    },
    handlers: {
      live: {
        opened(state, { params }, transition) {
          modalSteps.open(state, params, transition);
        },
        loginAsked: askLogin,
        phraseAsked: askPhrase,
        retryAsked(state, _event, transition) {
          if (isPhraseRound(state.round)) {
            askPhrase(state, { kind: 'phraseAsked' }, transition);
            return;
          }
          askLogin(state, { kind: 'loginAsked', params: {} }, transition);
        },
        /** The saved session was read again, so the sign-in it held up goes on, or the modal says why it cannot. */
        rereadEnded(state, { round }, transition) {
          // A modal closed or moved on meanwhile stays as it is.
          if (round !== state.round || round.kind !== 'rereading') {
            return;
          }
          const { asked } = round;
          const next: LiveModal = { ...state, round: { kind: 'idle' } };
          switch (authViews.getSessionKnowledge(state.auth)) {
            case 'unreachable':
              showView({ ...state, round: { kind: 'rereadMissed', asked } }, UNREACHABLE_VIEW, transition);
              return;
            case 'reading':
              // A read is under way, so the click starts nothing.
              transition.emitState(next);
              return;
            case 'known':
              break;
          }
          transition.emitState(next);
          // A sign-in is under way, or the user is signed in, so the click starts nothing.
          if (!authViews.isSignInIdle(state.auth)) {
            return;
          }
          // A window opens only in a click's own turn, which has passed, so the page asks for one.
          if (handoff !== null) {
            showView(next, { kind: 'prompt', resume: elsewhere() }, transition);
            return;
          }
          switch (asked) {
            case 'login':
              modalSteps.run({ step: 'login', params: { reason: round.reason } }, transition);
              return;
            case 'phrase':
              route.importPhrase(next, { kind: 'phraseAsked' }, transition);
              return;
          }
        },
        rereadFailed(state, { round, error }, transition) {
          transition.emitSideEffect({ kind: 'rereadLogged', error });
          // A modal closed or moved on meanwhile stays as it is.
          if (round !== state.round || round.kind !== 'rereading') {
            return;
          }
          showView({ ...state, round: { kind: 'rereadMissed', asked: round.asked } }, UNREACHABLE_VIEW, transition);
        },
        closeAsked(state, { params }, transition) {
          close(state, params, transition);
        },
        disableAsked(state, _event, transition) {
          const { emitState, emitSideEffect } = transition;
          if (!isLeaseHeld(state.lease)) {
            emitState({ ...state, lease: { kind: 'disabled' } });
            return;
          }
          // The route's wait goes on and its own outcome ends the core's login, so only the modal is released.
          if (isWaiting(state.round)) {
            emitState({ ...state, lease: { kind: 'disabled' }, view: { kind: 'spinner' } });
            emitSideEffect({ kind: 'leaseReleased', lease: state.lease });
            return;
          }
          emitState({ ...state, lease: { kind: 'disabled' }, round: { kind: 'idle' }, view: { kind: 'spinner' } });
          emitSideEffect({ kind: 'roundEnded', reason: 'page' });
          emitSideEffect({ kind: 'leaseReleased', lease: state.lease });
          modalSteps.run({ step: 'cancel_login' }, transition);
        },
        disposeAsked(state, _event, { emitState, emitSideEffect }) {
          emitState({ kind: 'disposed' });
          emitSideEffect({ kind: 'stepsUnfollowed' });
          emitSideEffect({ kind: 'roundEnded', reason: 'page' });
          emitSideEffect({ kind: 'leaseReleased', lease: state.lease });
        },
        logoutAsked(_state, _event, transition) {
          // The route's sign-out window opens first, before any wait, since a browser opens a window only in the
          // click's own turn. The signed-in flag is not the controller's to write.
          transition.emitSideEffect({ kind: 'signOutOpened' });
          // With the bridge loaded, as on any signed-in page, this runs in the click's continuation, so a paired page
          // reads its copy before the window's document loads.
          modalSteps.run({ step: 'logout' }, transition);
        },
        focusAsked(_state, _event, { emitSideEffect }) {
          emitSideEffect({ kind: 'windowFocused' });
        },
        /** `Disconnected` leaves the modal alone, so an unrelated disconnect never closes an active pairing. */
        authStepped(previous, { state: authStep }, transition) {
          const state: LiveModal = { ...previous, auth: authStep };
          transition.emitState(state);
          const step = authViews.getLoginStep(authStep);
          transition.emitSideEffect({ kind: 'authLogged', tag: authStep.tag, failure: getFailureKind(step) });
          // A phrase the user is typing stays on show. The core's login waits behind it, and the modal's Cancel ends
          // both.
          if (step !== null && isLeaseHeld(state.lease) && state.view.kind === 'phrase') {
            return;
          }
          if (authViews.getSignedInSession(authStep) !== null) {
            // Only becoming signed in counts, so a session the core reports again leaves a phrase round started while
            // signed in open. The route's wait goes on until its own outcome, so closing the modal now would lose that
            // outcome.
            if (authViews.getSignedInSession(previous.auth) !== null || isWaiting(state.round)) {
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
                showView(state, { kind: 'authenticating' }, transition);
              }
              return;
            case 'failed':
              if (!isWaiting(state.round)) {
                modalSteps.showFailure(state, { failure: step.kind, reason: step.reason }, transition);
              }
              return;
            case undefined:
              return;
          }
        },
        /** Puts the modal on screen once the queue grants its lease, unless the scope was replaced or disposed. */
        leaseGranted(state, { scope, signal, release }, { emitState, emitSideEffect }) {
          if (state.lease.kind !== 'queued' || scope !== state.lease.scope || signal.aborted) {
            emitSideEffect({ kind: 'leaseRefused', release });
            return;
          }
          emitState({ ...state, lease: { kind: 'open', scope, release } });
          emitSideEffect({ kind: 'modalShown' });
        },
        failureShown: modalSteps.showFailure,
        viewAsked(state, { view }, transition) {
          showView(state, view, transition);
        },
        windowEnded: handleRound,
        resultWritten: handleRound,
        resultFailed: handleRound,
        phraseLoaded: handleRound,
        phraseMissed: handleRound,
      },
      disposed: null,
    },
    onEffect(effect) {
      switch (effect.kind) {
        case 'authLogged': {
          const { tag, failure } = effect;
          report.log.event('auth state', { state: tag, ...(failure === null ? {} : { kind: failure }) });
          return;
        }
        case 'modalReset':
          authModalState.update({
            productLabel: effect.productLabel,
            reason: effect.reason,
            view: { kind: 'spinner' },
          });
          return;
        case 'viewShown':
          authModalState.update({ view: effect.view });
          return;
        case 'modalShown':
          authModalState.update({ open: true });
          return;
        case 'leaseQueued':
          queueLease(effect.scope);
          return;
        case 'leaseReleased':
          releaseLeaseHold(effect.lease);
          authModalState.reset();
          return;
        case 'leaseRefused':
          effect.release();
          return;
        case 'rereadLogged':
          log.error('[dot.li auth] saved session re-read failed:', effect.error);
          return;
        case 'roundEnded':
          route.end(effect.reason);
          return;
        case 'stepsUnfollowed':
          unlisten();
          return;
        case 'signOutOpened':
          route.signOut();
          return;
        case 'windowFocused':
          route.focus();
          return;
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: authModalTransitionMetric,
        message: '[dot.li auth] A sign-in modal transition threw',
      });
    },
  });

  const unlisten = subscribeAuthSteps(state => {
    machine.update({ kind: 'authStepped', state });
  });

  /** Takes the modal off screen and ends the route's round, cancelling the core's login unless `params` says not to. */
  function close(
    state: LiveModal,
    { skipTruapiCancel, cancel = 'page' }: CloseAuthModalParams,
    transition: Transition<AuthModalMachine>,
  ): void {
    // A disabled lease stays disabled, so a close never brings back a broken modal island.
    const lease: ModalLease = isLeaseDisabled(state.lease) ? state.lease : { kind: 'closed' };
    transition.emitState({ ...state, lease, round: { kind: 'idle' }, view: { kind: 'spinner' } });
    transition.emitSideEffect({ kind: 'roundEnded', reason: cancel });
    transition.emitSideEffect({ kind: 'leaseReleased', lease: state.lease });
    if (skipTruapiCancel !== true) {
      // A user close stops the core's pairing poll, which then resolves as Rejected.
      modalSteps.run({ step: 'cancel_login' }, transition);
    }
  }

  /** Waits for the screen in the blocking-modal queue, holding it until the lease is released or its scope ends. */
  function queueLease(scope: BlockingModalScope): void {
    void scope
      .enqueue(
        signal =>
          new Promise<void>(release => {
            // A scope disposed while the modal is open frees the queue with no event.
            signal.addEventListener(
              'abort',
              () => {
                release();
              },
              { once: true },
            );
            machine.update({ kind: 'leaseGranted', scope, signal, release });
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
  }

  /** Reads the saved session again for a sign-in asked while it could not be reached, the modal on its spinner. */
  function startReread(
    opened: LiveModal,
    round: Extract<SignInRound, { kind: 'rereading' }>,
    { emitState, update }: Transition<AuthModalMachine>,
  ): void {
    emitState({ ...opened, round });
    update(
      bridge()
        .then(loaded => loaded.rereadSession())
        .then(
          (): AuthModalEvent => ({ kind: 'rereadEnded', round }),
          (error: unknown): AuthModalEvent => ({ kind: 'rereadFailed', round, error }),
        ),
    );
  }

  return {
    /**
     * Opens the sign-in window and waits for it, asking it to resume a sign-in made elsewhere when one waits, or with
     * no window opens the modal and asks the core to log in. Does nothing while a login is already on show or the user
     * is signed in. The window opens before this returns, so a click handler reaches it with no wait between. While the
     * saved session cannot be reached, reads it again first, and then signs in, asks for a click to open the window, or
     * says why it cannot. Never throws.
     */
    startLogin(params: StartLoginParams = {}): void {
      machine.update({ kind: 'loginAsked', params });
    },
    /**
     * Opens the sign-in window at its recovery phrase view and waits for it, or with no window opens the modal at its
     * phrase view. Also runs for a signed-in user, who replaces the local wallet. While the saved session cannot be
     * reached, reads it again first, and then goes on, asks for a click to open the window, or says why it cannot.
     * Never throws.
     */
    importPhrase(): void {
      machine.update({ kind: 'phraseAsked' });
    },
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
     * The modal's Retry, Try again and Sign in. Asks for what the round on show asked for again: the recovery phrase
     * after a phrase round, else a sign-in. Never throws.
     */
    retryLogin(): void {
      machine.update({ kind: 'retryAsked' });
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
    openAuthModal(params: OpenAuthModalParams = {}): boolean {
      machine.update({ kind: 'opened', params });
      const state = machine.state.get();
      return state.kind === 'live' && isLeaseHeld(state.lease);
    },
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
