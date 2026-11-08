// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-in modal's state machine, which writes the page's modal store. Imports no Solid and loads eagerly because
// auth states arrive from boot, before any modal view mounts. The controller owns the modal and picks one sign-in route
// per surface: the sign-in window's on a page that has one, or the page's own, which pairs in place on the core in the
// bridge chunk, reached through `commands`.

import { withActiveTld } from '@dotli/config';
import { reportDefect, spans as S } from '@dotli/metrics';
import { getErrorMessage, log, registerStoreStateReset } from '@dotli/shared';
import type { LoginFailureKind } from '@parity/truapi-host';
import type { ReadableAtom } from 'nanostores';
import type { AuthCommands, LoginParams } from './createAuthCommands.js';
import type { BlockingModalCoordinator, BlockingModalScope } from './createBlockingModalCoordinator.js';
import { createInPageSignIn, type InPagePhrase } from './createInPageSignIn.js';
import { authViews, type LoginStep } from './session/authViews.js';
import type { DotliAuthState } from './session/types.js';
import type { SessionHandoff } from './sessionHandoff/createSessionHandoff.js';
import type { SessionResult } from './sessionHandoff/parseSessionResult.js';
import type {
  AuthModalPort,
  CloseAuthModalParams,
  OpenAuthModalParams,
  SignInRoute,
  StartLoginParams,
} from './signInRoute.js';
import { authState, type AuthState } from './state/authState.js';
import { sessionElsewhereState } from './state/sessionElsewhereState.js';
import { walletModeState } from './state/walletModeState.js';
import { createWindowSignIn } from './createWindowSignIn.js';
import { authModalState } from '../state/authModalState.js';
import { getLoginFailureView } from './getLoginFailureView.js';
import { rereadBeforeSignIn } from './rereadBeforeSignIn.js';

type Params = {
  coordinator: BlockingModalCoordinator;
  /**
   * The bridge chunk's commands. Awaited per intent, so an intent issued before the chunk loads still runs. Rejects when
   * the bridge chunk fails to load.
   */
  commands: () => Promise<AuthCommands>;
  /** The current auth step, read for each intent. */
  auth: ReadableAtom<DotliAuthState>;
  /** Hears every auth step, an equal one included, which the controller follows until it is disposed. */
  subscribeAuthSteps: AuthState['subscribeSteps'];
  /** The sign-in window, or null for a page that pairs in place. */
  handoff: SessionHandoff | null;
  /** Writes the window's result into this page's copy. Rejects with the failed step as the cause. */
  applyResult: (result: SessionResult) => Promise<'applied' | 'reloading'>;
  /** Whether the page runs on a local wallet now. Never throws. */
  isLocalWallet: () => boolean;
  /** Loaded the first time a page with no window asks for a phrase, so a page that never asks loads none of it. */
  inPagePhrase: () => Promise<InPagePhrase>;
  /** Whether the page shows signed out while a sign-in made elsewhere waits, which a sign-in then resumes. */
  elsewhere: () => boolean;
  /** Reads the saved session again and settles once the page shows it. Rejects when the bridge chunk fails to load. */
  rereadSession: () => Promise<void>;
};

/** What the slot's `init` takes: the controller's params, less the page stores the slot reads itself. */
type InitParams = Omit<Params, 'auth' | 'subscribeAuthSteps' | 'isLocalWallet' | 'elsewhere'>;

type CommandStep = 'login' | 'logout' | 'cancel_login';

export type AuthController = ReturnType<typeof createAuthController>;

/** Returns the controller of the page's sign-in modal, which follows the auth steps until it is disposed. */
export function createAuthController({
  coordinator,
  commands,
  auth,
  subscribeAuthSteps,
  handoff,
  applyResult,
  isLocalWallet,
  inPagePhrase,
  elsewhere,
  rereadSession,
}: Params) {
  let authModalScope: BlockingModalScope | null = null;
  let releaseAuthModal: (() => void) | null = null;
  let authModalDisabled = false;

  function runCommand(step: CommandStep, run: (commands: AuthCommands) => unknown): void {
    const message = `[dot.li auth] ${step} failed:`;

    function showLoginFailure(error: unknown): void {
      if (step === 'login') {
        showFailure('Other', getErrorMessage(error));
      }
    }

    // The getter resolves to the chunk boot already awaited, so a failure here is a wiring fault boot reported first.
    function failToLoad(error: unknown): void {
      log.error(message, error);
      showLoginFailure(error);
    }

    function failCommand(error: unknown): void {
      reportDefect(error, { flow: 'wallet', step, metric: S.AUTH_COMMAND, message, attributes: { step } });
      showLoginFailure(error);
    }

    void commands().then(
      loaded =>
        Promise.resolve()
          .then(() => run(loaded))
          .catch(failCommand),
      failToLoad,
    );
  }

  function cancelTruapiLogin(): void {
    runCommand('cancel_login', loaded => {
      loaded.cancelLogin();
    });
  }

  function ensureAuthModalLease(): void {
    if (authModalScope !== null) {
      return;
    }
    const scope = coordinator.createScope();
    authModalScope = scope;
    void scope
      .enqueue(
        signal =>
          new Promise<void>(resolve => {
            if (authModalScope !== scope || signal.aborted) {
              resolve();
              return;
            }

            function finish(): void {
              signal.removeEventListener('abort', finish);
              if (releaseAuthModal === finish) {
                releaseAuthModal = null;
              }
              resolve();
            }
            releaseAuthModal = finish;
            signal.addEventListener('abort', finish, { once: true });
            authModalState.update({ open: true });
          }),
      )
      .catch((error: unknown) => {
        // Closing the modal disposes its lease, which rejects with an AbortError.
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          reportDefect(error, {
            flow: 'wallet',
            step: 'auth_modal_lease',
            metric: S.AUTH_MODAL_LEASE,
            message: '[dot.li auth] authentication modal lease failed:',
          });
        }
      });
  }

  function openAuthModal({ reason, label, dotSuffix }: OpenAuthModalParams = {}): boolean {
    if (authModalDisabled) {
      cancelTruapiLogin();
      return false;
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
    ensureAuthModalLease();
    return true;
  }

  /** Takes the modal off screen and gives up its lease, leaving any login it showed running. */
  function releaseModal(): void {
    authModalState.reset();
    const scope = authModalScope;
    const release = releaseAuthModal;
    authModalScope = null;
    releaseAuthModal = null;
    release?.();
    scope?.dispose('Authentication modal closed');
  }

  function closeAuthModal({ skipTruapiCancel, cancel = 'page' }: CloseAuthModalParams = {}): void {
    route.end(cancel);
    releaseModal();

    if (skipTruapiCancel !== true) {
      // A user close stops the core's pairing poll, which then resolves as Rejected.
      cancelTruapiLogin();
    }
  }

  function showFailure(kind: LoginFailureKind, reason: string): void {
    openAuthModal();
    authModalState.update({ view: getLoginFailureView(kind, reason) });
  }

  /** `Disconnected` leaves the modal alone, so an unrelated disconnect never closes an active pairing. */
  function applyAuthState(state: DotliAuthState, wasSignedIn: boolean): void {
    const step = authViews.getLoginStep(state);
    const kind = getFailureKind(step);
    // The tag and failure kind only: a failure's reason can carry wallet text.
    log.event('auth state', {
      flow: 'wallet',
      state: state.tag,
      ...(kind === undefined ? {} : { kind }),
    });
    // A phrase the user is typing stays on show. The core's login waits behind it, and the modal's Cancel ends both.
    if (step !== null && authModalScope !== null && authModalState.store.get().view.kind === 'phrase') {
      return;
    }
    if (authViews.getSignedInSession(state) !== null) {
      // Only becoming signed in counts, so a session the core reports again leaves a phrase round started while signed
      // in open. The route's wait goes on until its own outcome, so closing the modal now would lose that outcome.
      if (wasSignedIn || route.isWaiting()) {
        return;
      }
      // A sign-in by another route ends a sign-in the page still waits on, such as a blocked window's.
      closeAuthModal({ skipTruapiCancel: true, cancel: 'signed_in' });
      return;
    }
    switch (step?.step) {
      case 'pairing':
        route.pairing(step.pairing);
        break;
      case 'authenticating':
        // The core's own states must not cover the route's wait.
        if (!route.isWaiting()) {
          authModalState.update({ view: { kind: 'authenticating' } });
        }
        break;
      case 'failed':
        if (!route.isWaiting()) {
          showFailure(step.kind, step.reason);
        }
        break;
      case undefined:
        break;
    }
  }

  const modal: AuthModalPort = {
    open: openAuthModal,
    getLease: () => authModalScope,
    getViewKind: () => authModalState.store.get().view.kind,
    show(view) {
      authModalState.update({ view });
    },
    showFailure,
    close: closeAuthModal,
  };

  function loginInPage(params?: LoginParams): void {
    runCommand('login', loaded => loaded.login(params));
  }

  const route: SignInRoute =
    handoff === null
      ? createInPageSignIn({
          inPagePhrase,
          modal,
          login: loginInPage,
        })
      : createWindowSignIn({
          handoff,
          applyResult,
          elsewhere,
          isLocalWallet,
          modal,
        });

  let lastSignedIn = authViews.getSignedInSession(auth.get()) !== null;
  const unlisten = subscribeAuthSteps(state => {
    const wasSignedIn = lastSignedIn;
    lastSignedIn = authViews.getSignedInSession(state) !== null;
    applyAuthState(state, wasSignedIn);
  });

  function startLogin(params: StartLoginParams = {}): void {
    const state = auth.get();
    // A pairing writes its session to the shared store, so one started while the store is down would be lost.
    if (authViews.isSessionUnreachable(state)) {
      void rereadBeforeSignIn({
        open: () => openAuthModal({ reason: params.reason, label: params.label }),
        modal,
        rereadSession,
        auth,
        proceed:
          handoff === null
            ? () => {
                loginInPage({ reason: params.reason });
              }
            : null,
        elsewhere,
      });
      return;
    }
    if (authViews.getSignedInSession(state) !== null) {
      return;
    }
    route.startLogin(params);
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
                route.importPhrase();
              }
            : null,
        elsewhere,
      });
      return;
    }
    route.importPhrase();
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
      return route.isValidPhrase(phrase);
    },
    /**
     * Uses the wallet of a phrase the modal's phrase view took, which reloads the page. Rejects when it could not be
     * saved, which the switch reported, when the phrase import has not loaded, which is reported here, or when the
     * phrase is not valid, which is the user's input and goes unreported.
     */
    importPhraseInPage(phrase: string): Promise<void> {
      return route.importPhraseInPage(phrase);
    },
    /**
     * The modal's Retry, Try again and Sign in. Asks for the recovery phrase again after a phrase round on show, else
     * starts a sign-in. Never throws.
     */
    retryLogin(): void {
      if (route.isPhraseRound()) {
        importPhrase();
      } else {
        startLogin();
      }
    },
    /** Opens the sign-out window before this returns, then asks the core to log out. Never throws. */
    logout(): void {
      // The route's sign-out window opens first, before any wait, since a browser opens a window only in the click's
      // own turn. The signed-in flag is not the controller's to write.
      route.signOut();
      // With the bridge loaded, as on any signed-in page, this runs in the click's continuation, so a paired page reads
      // its copy before the window's document loads.
      runCommand('logout', loaded => loaded.logout());
    },
    /** Brings the sign-in window of the open round to the front. Never throws. */
    focusSignInWindow(): void {
      route.focus();
    },
    /** Opens the modal and returns true, or returns false when the modal is disabled, having cancelled the login. */
    openAuthModal,
    /** Closes the modal, cancelling the login it showed unless `params` says not to. Never throws. */
    closeAuthModal,
    /**
     * For when the auth-modal island failed. A login would otherwise hold the blocking-modal lease for a modal nobody
     * can close, stalling every later prompt. A sign-in window already open still signs in. Never throws.
     */
    disableAuthModal(): void {
      authModalDisabled = true;
      if (authModalScope === null) {
        return;
      }
      // The route's wait goes on and its own outcome ends the core's login, so only the modal is released.
      if (route.isWaiting()) {
        releaseModal();
        return;
      }
      closeAuthModal();
    },
    /** Stops following the auth state and closes the modal without cancelling a login. Never throws. */
    dispose(): void {
      unlisten();
      closeAuthModal({ skipTruapiCancel: true });
    },
  };
}

/** The core's failure kind of a login step, or undefined when the step is not a failure. */
function getFailureKind(step: LoginStep | null): LoginFailureKind | undefined {
  switch (step?.step) {
    case 'failed':
      return step.kind;
    case 'pairing':
    case 'authenticating':
    case undefined:
      return undefined;
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
