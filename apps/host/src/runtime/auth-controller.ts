// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The QR pairing modal's state machine, which writes the page's modal store. Imports no Solid and loads eagerly because
// auth states arrive from boot, before any modal view mounts. The login itself runs in the bridge chunk, reached through
// `commands`.

import { withActiveTld } from '@dotli/config';
import { captureException } from '@dotli/metrics';
import { errorMessage, log, type ReadableStore, registerStoreStateReset } from '@dotli/shared';
import type { AuthCommands } from './core-login.js';
import type { BlockingModalCoordinator, BlockingModalScope } from './blocking-modal-queue.js';
import type { DotliAuthState } from './session/auth-state.js';
import { authStore } from './state/auth.js';
import { authModalStore, resetAuthModal, updateAuthModal } from '../state/auth-modal.js';

export interface AuthControllerDeps {
  coordinator: BlockingModalCoordinator;
  /** The bridge chunk's commands. Awaited per intent, so an intent issued before the chunk loads still runs. */
  commands: () => Promise<AuthCommands>;
  auth: ReadableStore<DotliAuthState>;
}

export interface AuthController {
  /** Opens the modal and asks the core to log in, unless the modal already shows a login or the user is signed in. */
  startLogin(reason?: string, label?: string): void;
  logout(): void;
  /** Returns false when the modal is disabled, having cancelled the login instead. */
  openAuthModal(reason?: string, label?: string, options?: { dotSuffix?: boolean | undefined }): boolean;
  closeAuthModal(opts?: { skipTruapiCancel?: boolean }): void;
  /**
   * For when the auth-modal island failed. A login would otherwise hold the blocking-modal lease for a
   * modal nobody can close, stalling every later prompt.
   */
  disableAuthModal(): void;
  /** Stops following the auth state and closes the modal without cancelling a login. */
  dispose(): void;
}

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

  const closeAuthModal: AuthController['closeAuthModal'] = (opts = {}) => {
    resetAuthModal();
    const scope = authModalScope;
    const release = releaseAuthModal;
    authModalScope = null;
    releaseAuthModal = null;
    release?.();
    scope?.dispose('Authentication modal closed');

    if (opts.skipTruapiCancel !== true) {
      // A user close stops the core's pairing poll, which then resolves as Rejected.
      cancelTruapiLogin();
    }
  };

  function showFailure(kind: Extract<DotliAuthState, { tag: 'LoginFailed' }>['kind'], reason: string): void {
    openAuthModal();
    const friendly = kind === 'NoFreeAllowanceSlots' ? exhaustedAllowanceError(reason) : friendlyAuthError(reason);
    updateAuthModal({
      view: {
        kind: 'error',
        message: reason,
        retry: friendly.retryable !== false,
        pending: friendly.pending === true,
        title: friendly.title,
        subtitle: friendly.subtitle,
        detail: friendly.detail,
      },
    });
  }

  /** `Disconnected` leaves the modal alone, so an unrelated disconnect never closes an active pairing. */
  const applyAuthState = (state: DotliAuthState): void => {
    // The tag and failure kind only: a failure's reason can carry wallet text.
    log.event('auth state', {
      flow: 'wallet',
      state: state.tag,
      ...(state.tag === 'LoginFailed' ? { kind: state.kind } : {}),
    });
    switch (state.tag) {
      case 'Restoring':
      case 'Disconnected':
      case 'Unreachable':
        break;
      case 'Pairing':
        openAuthModal(undefined, state.hostGlobal === true ? undefined : state.label, { dotSuffix: state.dotSuffix });
        if (state.deeplink) {
          updateAuthModal({
            view: { kind: 'pairing', payload: state.deeplink },
          });
        }
        break;
      case 'Authenticating':
        updateAuthModal({ view: { kind: 'authenticating' } });
        break;
      case 'Connected':
        closeAuthModal({ skipTruapiCancel: true });
        break;
      case 'LoginFailed':
        showFailure(state.kind, state.reason);
        break;
    }
  };

  // The store never drops a set as equal, so every step of the ordered stream reaches here.
  const unsubscribe = deps.auth.subscribe(() => {
    applyAuthState(deps.auth.get());
  });

  return {
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
      // The modal already shows that login, and a reset would swap its QR for a spinner that never resolves. An error
      // shows none, so its Retry logs in again.
      if (authModalScope !== null && authModalStore.get().view.kind !== 'error') {
        return;
      }
      if (openAuthModal(reason, label)) {
        runCommand('login', commands => commands.login(reason));
      }
    },
    logout() {
      runCommand('logout', commands => commands.logout());
    },
    openAuthModal,
    closeAuthModal,
    disableAuthModal() {
      authModalDisabled = true;
      if (authModalScope !== null) {
        closeAuthModal();
      }
    },
    dispose() {
      unsubscribe();
      closeAuthModal({ skipTruapiCancel: true });
    },
  };
}

export interface FriendlyAuthError {
  title: string;
  subtitle: string;
  detail?: string | undefined;
  retryable?: boolean | undefined;
  pending?: boolean | undefined;
}

interface AuthErrorRule {
  match: RegExp;
  title: string;
  subtitle: string;
  retryable?: boolean;
  pending?: boolean;
  hideDetail?: boolean;
}

// First match wins, so specific rules sit above the broad buckets.
const AUTH_ERROR_RULES: readonly AuthErrorRule[] = [
  {
    match: /Invalid Transaction|rejected by the node|re-broadcast rejected/,
    title: 'Statement Store transaction rejected',
    subtitle: 'Polkadot App could not register this browser because the chain rejected the registration transaction.',
  },
  {
    match: /SubstrateSdk\.JSONRPCError error 1/,
    title: 'Statement Store registration failed',
    subtitle: 'Polkadot App reported a JSON-RPC failure while registering this browser as a device.',
  },
  {
    match: /OriginPersonProviderError/,
    title: 'Your account is still being set up',
    subtitle: 'Please try again later',
    pending: true,
    hideDetail: true,
  },
  {
    match: /version mismatch|unsupported version|incompatible|malformed ?frame/i,
    title: 'Update Polkadot App',
    subtitle: 'This browser and Polkadot App are out of step. Update the app and try again.',
  },
  {
    match: /denied|rejected|declined/i,
    title: 'Sign-in was declined',
    subtitle: 'The request was declined in Polkadot App. Start again and approve it on your phone.',
  },
  {
    match: /cancel/i,
    title: 'Sign-in was cancelled',
    subtitle: 'The pairing stopped before it finished. Try again when you are ready.',
  },
  {
    match: /timed? ?out|timeout/i,
    title: 'Sign-in timed out',
    subtitle: 'Polkadot App did not answer in time. Check that your phone is online and try again.',
  },
  {
    match: /not supported|unsupported/i,
    title: 'Sign-in is not available here',
    subtitle: 'This page cannot sign you in with Polkadot App.',
    retryable: false,
  },
  {
    match: /worker init failed|wasm|webassembly|dynamically imported module|auth host was disposed/i,
    title: 'The sign-in service did not start',
    subtitle: 'This page could not start its sign-in runtime. Reload the page and try again.',
  },
  {
    match:
      /disconnected|connection is closed|transport closed|not connected|connection (refused|reset|aborted)|network (unreachable|down)|host unreachable|failed to fetch|networkerror|load failed/i,
    title: 'Connection to Polkadot App was lost',
    subtitle:
      'The link between this browser and your phone dropped before sign-in finished. Check that both are online and try again.',
  },
  {
    match: /handshake|statement[- ]store|allowance/i,
    title: 'Pairing could not complete',
    subtitle: 'This browser and Polkadot App could not exchange their pairing messages. Try again in a moment.',
  },
];

function exhaustedAllowanceError(message: string): FriendlyAuthError {
  return {
    title: 'No Statement Store slots left',
    subtitle:
      'Polkadot App has no free slot to register this browser. Try again once the current allowance period rolls over.',
    detail: message,
    retryable: false,
  };
}

/** Unknown reasons keep the raw text as a detail line for bug reports. */
export function friendlyAuthError(message: string): FriendlyAuthError {
  const rule = AUTH_ERROR_RULES.find(candidate => candidate.match.test(message));
  if (rule === undefined) {
    return {
      title: 'Sign-in did not complete',
      subtitle:
        'Something interrupted the connection to Polkadot App. Try again, and make sure the app is installed and up to date.',
      detail: message,
    };
  }
  return {
    title: rule.title,
    subtitle: rule.subtitle,
    detail: rule.hideDetail === true ? undefined : message,
    retryable: rule.retryable,
    pending: rule.pending,
  };
}

// The page's controller, for islands that hydrate on their own and so cannot be handed one.
let pageController: AuthController | null = null;
// An island can fail to hydrate before boot starts the controller.
let pageModalBroken = false;

export function initAuthController(deps: Omit<AuthControllerDeps, 'auth'>): AuthController {
  pageController?.dispose();
  const controller = createAuthController({ ...deps, auth: authStore });
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
export { startLogin as retryLogin };

export function logout(): void {
  requireController().logout();
}

export function closeAuthModal(opts: { skipTruapiCancel?: boolean } = {}): void {
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
