// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-in modal's state machine, which writes the page's modal store. Imports no Solid and loads eagerly because
// auth states arrive from boot, before any modal view mounts. The controller owns the modal and picks one sign-in route
// per surface: the sign-in window's on a page that has one, or the page's own, which pairs in place on the core in the
// bridge chunk, reached through `commands`.

import { withActiveTld } from '@dotli/config';
import { captureException } from '@dotli/metrics';
import { errorMessage, log, type ReadableStore, registerStoreStateReset } from '@dotli/shared';
import type { AuthCommands } from './core-login.js';
import type { BlockingModalCoordinator, BlockingModalScope } from './blocking-modal-queue.js';
import { createInPageSignIn, type InPagePhrase } from './in-page-sign-in.js';
import type { DotliAuthState } from './session/auth-state.js';
import type { SessionResult } from './session-handoff/messages.js';
import type { SessionHandoff } from './session-handoff/opener.js';
import type { AuthModalPort, CloseAuthModalOptions, SignInRoute } from './sign-in-route.js';
import { authStore } from './state/auth.js';
import { sessionElsewhereStore } from './state/session-elsewhere.js';
import { getWalletMode, type WalletMode } from './state/wallet-mode.js';
import { createWindowSignIn } from './window-sign-in.js';
import { authModalStore, resetAuthModal, updateAuthModal } from '../state/auth-modal.js';
import { loginFailureView, type LoginFailureKind } from './login-failure.js';

export type { CloseAuthModalOptions, InPagePhrase };

export type AuthControllerDeps = {
  coordinator: BlockingModalCoordinator;
  /** The bridge chunk's commands. Awaited per intent, so an intent issued before the chunk loads still runs. */
  commands: () => Promise<AuthCommands>;
  auth: ReadableStore<DotliAuthState>;
  /** The sign-in window, or null for a page that pairs in place. */
  handoff: SessionHandoff | null;
  /** Writes the window's result into this page's copy. Rejects with the failed step as the cause. */
  applyResult: (result: SessionResult) => Promise<'applied' | 'reloading'>;
  walletMode: () => WalletMode;
  /** Loaded the first time a page with no window asks for a phrase, so a page that never asks loads none of it. */
  inPagePhrase: () => Promise<InPagePhrase>;
  /** Whether the page shows signed out while a sign-in made elsewhere waits, which a sign-in then resumes. */
  elsewhere: () => boolean;
};

export type AuthController = {
  /**
   * Opens the sign-in window and waits for it, asking it to resume a sign-in made elsewhere when one waits, or with no
   * window opens the modal and asks the core to log in. Does
   * nothing while a login is already on show or the user is signed in. The window opens before this returns, so a
   * click handler reaches it with no wait between.
   */
  startLogin(reason?: string, label?: string): void;
  /**
   * Opens the sign-in window at its recovery phrase view and waits for it, or with no window opens the modal at its
   * phrase view. Also runs for a signed-in user, who replaces the local wallet.
   */
  importPhrase(): void;
  /** Whether the modal's phrase view takes `phrase`. */
  isValidPhrase(phrase: string): boolean;
  /**
   * Uses the wallet of a phrase the modal's phrase view took, which reloads the page. Rejects when it could not be
   * saved, which the switch reported, when the phrase import has not loaded, which is reported here, or when the phrase
   * is not valid, which is the user's input and goes unreported.
   */
  importPhraseInPage(phrase: string): Promise<void>;
  /**
   * The modal's Retry, Try again and Sign in. Asks for the recovery phrase again after a phrase round on show, else
   * starts a sign-in.
   */
  retryLogin(): void;
  /** Opens the sign-out window before this returns, then asks the core to log out. */
  logout(): void;
  /** Brings the sign-in window of the open round to the front. */
  focusSignInWindow(): void;
  /** Returns false when the modal is disabled, having cancelled the login instead. */
  openAuthModal(reason?: string, label?: string, options?: { dotSuffix?: boolean | undefined }): boolean;
  closeAuthModal(opts?: CloseAuthModalOptions): void;
  /**
   * For when the auth-modal island failed. A login would otherwise hold the blocking-modal lease for a
   * modal nobody can close, stalling every later prompt. A sign-in window already open still signs in.
   */
  disableAuthModal(): void;
  /** Stops following the auth state and closes the modal without cancelling a login. */
  dispose(): void;
};

type CommandStep = 'login' | 'logout' | 'cancel_login';

export function createAuthController(deps: AuthControllerDeps): AuthController {
  let authModalScope: BlockingModalScope | null = null;
  let releaseAuthModal: (() => void) | null = null;
  let authModalDisabled = false;

  // The getter resolves to the chunk boot already awaited, so a failure here is a wiring fault boot reported first.
  const runCommand = (step: CommandStep, run: (commands: AuthCommands) => unknown): void => {
    const fail = (error: unknown): void => {
      log.error(`[dot.li auth] ${step} failed:`, error);
      if (step === 'login') {
        showFailure('Other', errorMessage(error));
      }
    };
    void deps.commands().then(
      commands =>
        Promise.resolve()
          .then(() => run(commands))
          .catch((error: unknown) => {
            captureException(error, { flow: 'wallet', step });
            fail(error);
          }),
      fail,
    );
  };

  const cancelTruapiLogin = (): void => {
    runCommand('cancel_login', commands => {
      commands.cancelLogin();
    });
  };

  const ensureAuthModalLease = (): void => {
    if (authModalScope !== null) {
      return;
    }
    const scope = deps.coordinator.createScope();
    authModalScope = scope;
    void scope
      .enqueue(
        signal =>
          new Promise<void>(resolve => {
            if (authModalScope !== scope || signal.aborted) {
              resolve();
              return;
            }

            const finish = (): void => {
              signal.removeEventListener('abort', finish);
              if (releaseAuthModal === finish) {
                releaseAuthModal = null;
              }
              resolve();
            };
            releaseAuthModal = finish;
            signal.addEventListener('abort', finish, { once: true });
            updateAuthModal({ open: true });
          }),
      )
      .catch((error: unknown) => {
        // Closing the modal disposes its lease, which rejects with an AbortError.
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          log.warn('[dot.li auth] authentication modal lease failed:', error);
        }
      });
  };

  const openAuthModal: AuthController['openAuthModal'] = (reason, label, options = {}) => {
    if (authModalDisabled) {
      cancelTruapiLogin();
      return false;
    }
    // A "localhost:<port>" label is a local dev server in localhost-proxy mode, shown as-is.
    let productLabel: string | null = null;
    if (label !== undefined && label.length > 0) {
      productLabel = label.startsWith('localhost:') || options.dotSuffix === false ? label : withActiveTld(label);
    }
    updateAuthModal({
      productLabel,
      reason: reason !== undefined && reason.length > 0 ? reason : null,
      view: { kind: 'spinner' },
    });
    ensureAuthModalLease();
    return true;
  };

  /** Takes the modal off screen and gives up its lease, leaving any login it showed running. */
  const releaseModal = (): void => {
    resetAuthModal();
    const scope = authModalScope;
    const release = releaseAuthModal;
    authModalScope = null;
    releaseAuthModal = null;
    release?.();
    scope?.dispose('Authentication modal closed');
  };

  const closeAuthModal: AuthController['closeAuthModal'] = (opts = {}) => {
    route.end(opts.cancel ?? 'page');
    releaseModal();

    if (opts.skipTruapiCancel !== true) {
      // A user close stops the core's pairing poll, which then resolves as Rejected.
      cancelTruapiLogin();
    }
  };

  function showFailure(kind: LoginFailureKind, reason: string): void {
    openAuthModal();
    updateAuthModal({ view: loginFailureView(kind, reason) });
  }

  /** `Disconnected` leaves the modal alone, so an unrelated disconnect never closes an active pairing. */
  const applyAuthState = (state: DotliAuthState, previous: DotliAuthState['tag']): void => {
    // The tag and failure kind only: a failure's reason can carry wallet text.
    log.event('auth state', {
      flow: 'wallet',
      state: state.tag,
      ...(state.tag === 'LoginFailed' ? { kind: state.kind } : {}),
    });
    // A phrase the user is typing stays on show. The core's login waits behind it, and the modal's Cancel ends both.
    const login = state.tag === 'Pairing' || state.tag === 'Authenticating' || state.tag === 'LoginFailed';
    if (login && authModalScope !== null && authModalStore.get().view.kind === 'phrase') {
      return;
    }
    switch (state.tag) {
      case 'Restoring':
      case 'Disconnected':
      case 'Unreachable':
        break;
      case 'Pairing':
        route.pairing(state);
        break;
      case 'Authenticating':
        // The core's own states must not cover the route's wait.
        if (!route.waiting()) {
          updateAuthModal({ view: { kind: 'authenticating' } });
        }
        break;
      case 'Connected':
        // Only becoming signed in counts, so a session the core reports again leaves a phrase round started while
        // signed in open.
        if (previous === 'Connected') {
          break;
        }
        // The route's wait goes on until its own outcome, so closing the modal now would lose that outcome.
        if (route.waiting()) {
          break;
        }
        // A sign-in by another route ends a sign-in the page still waits on, such as a blocked window's.
        closeAuthModal({ skipTruapiCancel: true, cancel: 'signed_in' });
        break;
      case 'LoginFailed':
        if (!route.waiting()) {
          showFailure(state.kind, state.reason);
        }
        break;
    }
  };

  const modal: AuthModalPort = {
    open: openAuthModal,
    lease: () => authModalScope,
    viewKind: () => authModalStore.get().view.kind,
    show(view) {
      updateAuthModal({ view });
    },
    showFailure,
    close: closeAuthModal,
  };

  const route: SignInRoute =
    deps.handoff === null
      ? createInPageSignIn({
          inPagePhrase: deps.inPagePhrase,
          modal,
          login(reason) {
            runCommand('login', commands => commands.login(reason));
          },
        })
      : createWindowSignIn({
          handoff: deps.handoff,
          applyResult: deps.applyResult,
          elsewhere: deps.elsewhere,
          walletMode: deps.walletMode,
          modal,
        });

  // The store never drops a set as equal, so every step of the ordered stream reaches here.
  let lastTag = deps.auth.get().tag;
  const unsubscribe = deps.auth.subscribe(() => {
    const state = deps.auth.get();
    const previous = lastTag;
    lastTag = state.tag;
    applyAuthState(state, previous);
  });

  const controller: AuthController = {
    startLogin(reason, label) {
      const state = deps.auth.get();
      // A pairing writes its session to the shared store, so one started while the store is down would be lost.
      if (state.tag === 'Unreachable') {
        log.event('sign-in refused while the saved session is unreachable', { flow: 'wallet' });
        return;
      }
      if (state.tag === 'Connected') {
        return;
      }
      route.startLogin(reason, label);
    },
    importPhrase() {
      if (deps.auth.get().tag === 'Unreachable') {
        log.event('phrase import refused while the saved session is unreachable', { flow: 'wallet' });
        return;
      }
      route.importPhrase();
    },
    isValidPhrase(phrase) {
      return route.isValidPhrase(phrase);
    },
    importPhraseInPage(phrase) {
      return route.importPhraseInPage(phrase);
    },
    retryLogin() {
      if (route.retriesPhrase()) {
        controller.importPhrase();
      } else {
        controller.startLogin();
      }
    },
    logout() {
      // The route's sign-out window opens first, before any wait, since a browser opens a window only in the click's
      // own turn. The signed-in flag is not the controller's to write.
      route.signOut();
      // With the bridge loaded, as on any signed-in page, this runs in the click's continuation, so a paired page reads
      // its copy before the window's document loads.
      runCommand('logout', commands => commands.logout());
    },
    focusSignInWindow() {
      route.focus();
    },
    openAuthModal,
    closeAuthModal,
    disableAuthModal() {
      authModalDisabled = true;
      if (authModalScope === null) {
        return;
      }
      // The route's wait goes on and its own outcome ends the core's login, so only the modal is released.
      if (route.waiting()) {
        releaseModal();
        return;
      }
      closeAuthModal();
    },
    dispose() {
      unsubscribe();
      closeAuthModal({ skipTruapiCancel: true });
    },
  };
  return controller;
}

// The page's controller, for islands that hydrate on their own and so cannot be handed one.
let pageController: AuthController | null = null;
// An island can fail to hydrate before boot starts the controller.
let pageModalBroken = false;

export function initAuthController(
  deps: Omit<AuthControllerDeps, 'auth' | 'walletMode' | 'elsewhere'>,
): AuthController {
  pageController?.dispose();
  const controller = createAuthController({
    ...deps,
    auth: authStore,
    walletMode: getWalletMode,
    elsewhere: () => sessionElsewhereStore.get(),
  });
  if (pageModalBroken) {
    controller.disableAuthModal();
  }
  pageController = controller;
  return controller;
}

function requireController(): AuthController {
  if (pageController === null) {
    throw new Error('Auth controller used before initAuthController');
  }
  return pageController;
}

export function startLogin(): void {
  requireController().startLogin();
}

export function retryLogin(): void {
  requireController().retryLogin();
}

export function importPhrase(): void {
  requireController().importPhrase();
}

export function isValidPhrase(phrase: string): boolean {
  return requireController().isValidPhrase(phrase);
}

export function importPhraseInPage(phrase: string): Promise<void> {
  return requireController().importPhraseInPage(phrase);
}

export function logout(): void {
  requireController().logout();
}

export function focusSignInWindow(): void {
  requireController().focusSignInWindow();
}

export function closeAuthModal(opts: CloseAuthModalOptions = {}): void {
  requireController().closeAuthModal(opts);
}

export function disableAuthModal(): void {
  pageModalBroken = true;
  pageController?.disableAuthModal();
}

registerStoreStateReset(() => {
  pageController?.dispose();
  pageController = null;
  pageModalBroken = false;
});
