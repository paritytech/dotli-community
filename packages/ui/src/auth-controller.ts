// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The QR pairing modal's state machine, free of Solid and eager: login and
// auth-state events arrive from boot onwards, before any modal view mounts.
// It owns the login and disconnect requests, the blocking-modal lease, and
// the auth-state to modal-view mapping, and writes state/auth-modal.ts. The
// view renders that store and calls back in here (closeAuthModal, retryLogin).

import { withActiveTld } from '@dotli/config';
import type { BlockingModalCoordinator, BlockingModalScope } from './blocking-modal-queue.js';
import { ERRORS } from './errors.js';
import type { DotliAuthState } from './host-callbacks/AuthState.js';
import { authStore, setLoggedIn } from './state/auth.js';
import { resetAuthModal, updateAuthModal } from './state/auth-modal.js';
import { isExperimentalWalletActive } from './host-callbacks/SessionStore.js';

let blockingModalCoordinator: BlockingModalCoordinator | null = null;
let authModalScope: BlockingModalScope | null = null;
let releaseAuthModal: (() => void) | null = null;
/** Set by disableAuthModal: no modal view can ever show. */
let authModalDisabled = false;

/**
 * Wire the login request and auth-state listeners and report the initial
 * logged-out state. Called once, from initTopBar.
 */
export function initAuthController(modalCoordinator: BlockingModalCoordinator): void {
  blockingModalCoordinator = modalCoordinator;

  window.addEventListener('dotli:request-login', (e: Event) => {
    const detail = (e as CustomEvent<{ reason?: string; label?: string }>).detail;
    if (openAuthModal(detail.reason, detail.label)) {
      requestTruapiLogin(detail.reason);
    }
  });

  // Single ordered auth-state stream owned by the Rust core (plus the boot
  // rehydration and bridge transport-failure synthetics). The store never
  // drops a set as equal, so every step reaches here. The modal closes only on `Connected`
  // or explicit user action; a `Disconnected` can never tear down an
  // in-flight pairing presentation.
  authStore.subscribe(() => {
    applyAuthState(authStore.get());
  });

  // Default logged-out state until the core or the boot rehydration says
  // otherwise.
  setLoggedIn(false);
  document.documentElement.classList.toggle('experimental-wallet-active', isExperimentalWalletActive());
}

/**
 * Apply one auth state. The modal lifecycle is state-driven: `Pairing`
 * opens it with the QR, `Authenticating` replaces the QR with progress,
 * `Connected` closes it, `LoginFailed` shows a retryable error, and
 * `Disconnected` only updates the session so an unrelated disconnect signal
 * can never close an active pairing modal.
 */
function applyAuthState(state: DotliAuthState): void {
  document.documentElement.classList.toggle('experimental-wallet-active', isExperimentalWalletActive());
  switch (state.tag) {
    case 'Disconnected':
      setLoggedIn(false);
      break;
    case 'WalletUnavailable':
      closeAuthModal({ skipTruapiCancel: true });
      setLoggedIn(false);
      break;
    case 'Pairing':
      openAuthModal(undefined, state.hostGlobal === true ? undefined : state.label, { dotSuffix: state.dotSuffix });
      // No deeplink yet: openAuthModal already shows the spinner.
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
      setLoggedIn(true);
      break;
    case 'LoginFailed': {
      openAuthModal();
      const friendly =
        state.kind === 'NoFreeAllowanceSlots' ? exhaustedAllowanceError(state.reason) : friendlyAuthError(state.reason);
      updateAuthModal({
        view: {
          kind: 'error',
          message: state.reason,
          retry: friendly.retryable !== false,
          title: friendly.title,
          subtitle: friendly.subtitle,
          detail: friendly.detail,
        },
      });
      break;
    }
  }
}

export interface FriendlyAuthError {
  title: string;
  subtitle: string;
  detail?: string | undefined;
  retryable?: boolean | undefined;
}

interface AuthErrorRule {
  match: RegExp;
  title: string;
  subtitle: string;
  retryable?: boolean;
  hideDetail?: boolean;
}

// First match wins, so chain-specific wording and runtime boot failures sit
// above the broad declined, timeout, and transport buckets.
const AUTH_ERROR_RULES: readonly AuthErrorRule[] = [
  {
    match: /Invalid Transaction|rejected by the node|re-broadcast rejected/,
    title: 'Statement Store transaction rejected',
    subtitle:
      'Polkadot Mobile could not register this browser because the chain rejected the registration transaction.',
  },
  {
    match: /SubstrateSdk\.JSONRPCError error 1/,
    title: 'Statement Store registration failed',
    subtitle: 'Polkadot Mobile reported a JSON-RPC failure while registering this browser as a device.',
  },
  {
    match: /OriginPersonProviderError/,
    title: 'Your account is still being set up',
    subtitle: 'Please try again later',
    hideDetail: true,
  },
  {
    match: /version mismatch|unsupported version|incompatible|malformed ?frame/i,
    title: 'Update Polkadot Mobile',
    subtitle: 'This browser and your Polkadot Mobile app are out of step. Update the app and try again.',
  },
  {
    match: /denied|rejected|declined/i,
    title: 'Login was declined',
    subtitle: 'The request was declined in Polkadot Mobile. Start again and approve it on your phone.',
  },
  {
    match: /cancel/i,
    title: 'Login was cancelled',
    subtitle: 'The pairing stopped before it finished. Try again when you are ready.',
  },
  {
    match: /timed? ?out|timeout/i,
    title: 'Login timed out',
    subtitle: 'Polkadot Mobile did not answer in time. Check that your phone is online and try again.',
  },
  {
    match: /not supported|unsupported/i,
    title: 'Login is not available here',
    subtitle: 'This page cannot sign you in with Polkadot Mobile.',
    retryable: false,
  },
  {
    match: /worker init failed|wasm|webassembly|dynamically imported module|auth host was disposed/i,
    title: 'The login service did not start',
    subtitle: 'This page could not start its login runtime. Reload the page and try again.',
  },
  {
    match:
      /disconnected|connection is closed|transport closed|not connected|connection (refused|reset|aborted)|network (unreachable|down)|host unreachable|failed to fetch|networkerror|load failed/i,
    title: 'Connection to Polkadot Mobile was lost',
    subtitle:
      'The link between this browser and your phone dropped before login finished. Check that both are online and try again.',
  },
  {
    match: /handshake|statement[- ]store|allowance/i,
    title: 'Pairing could not complete',
    subtitle: 'This browser and Polkadot Mobile could not exchange their pairing messages. Try again in a moment.',
  },
];

export function exhaustedAllowanceError(message: string): FriendlyAuthError {
  return {
    title: 'No Statement Store slots left',
    subtitle:
      'Polkadot Mobile has no free slot to register this browser. Try again once the current allowance period rolls over.',
    detail: message,
    // Retrying cannot succeed until the allowance period rolls over.
    retryable: false,
  };
}

// Map a wallet or transport failure to copy a first-time user can act on.
// Unknown reasons keep the raw text as a detail line for bug reports.
export function friendlyAuthError(message: string): FriendlyAuthError {
  const rule = AUTH_ERROR_RULES.find(candidate => candidate.match.test(message));
  if (rule === undefined) {
    return {
      title: 'Login did not complete',
      subtitle:
        'Something interrupted the connection to Polkadot Mobile. Try again, and make sure the app is installed and up to date.',
      detail: message,
    };
  }
  return {
    title: rule.title,
    subtitle: rule.subtitle,
    detail: rule.hideDetail === true ? undefined : message,
    retryable: rule.retryable,
  };
}

/** The login button while logged out, and the error view's Retry. */
export function startLogin(): void {
  if (isExperimentalWalletActive()) {
    window.dispatchEvent(new Event('dotli:wallet-open'));
    return;
  }
  if (openAuthModal()) {
    requestTruapiLogin();
  }
}
export { startLogin as retryLogin };

export function requestTruapiDisconnect(): void {
  window.dispatchEvent(new Event('dotli:truapi-disconnect-request'));
}

export function requestTruapiLogin(reason?: string): void {
  window.dispatchEvent(
    new CustomEvent('dotli:truapi-login-request', {
      detail: {
        reason,
      },
    }),
  );
}

/**
 * Present the modal (spinner view) and take the blocking-modal lease.
 * Returns false when the modal is disabled: the login is cancelled instead,
 * and nothing is presented.
 */
export function openAuthModal(
  reason?: string,
  label?: string,
  options: { dotSuffix?: boolean | undefined } = {},
): boolean {
  if (authModalDisabled) {
    cancelTruapiLogin();
    return false;
  }
  // A bare "localhost:<port>" label means dotli is in localhost-proxy
  // mode rendering a local dev server directly (apps/host/src/main.ts
  // localhost-proxy branch). Show it as-is. Deployed dotNs products
  // served via `<label>.localhost:<port>` still pass through as the bare
  // label and get the active network's TLD suffix.
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
}

/**
 * The modal view can never show (the auth-modal island failed to load or
 * render, see reportIslandErrors). A login would hold the blocking-modal
 * lease for a modal nobody can see or close, stalling every later blocking
 * prompt, so release any lease held now and, from here on, cancel each login
 * that would open the modal instead of taking the lease.
 */
export function disableAuthModal(): void {
  authModalDisabled = true;
  if (authModalScope !== null) {
    closeAuthModal();
  }
}

export function closeAuthModal(opts: { skipTruapiCancel?: boolean } = {}): void {
  resetAuthModal();
  const scope = authModalScope;
  const release = releaseAuthModal;
  authModalScope = null;
  releaseAuthModal = null;
  release?.();
  scope?.dispose('Authentication modal closed');

  if (opts.skipTruapiCancel !== true) {
    // User-initiated close: cancel any in-flight login in the core so the
    // pairing flow stops polling and resolves as Rejected.
    cancelTruapiLogin();
  }
}

function cancelTruapiLogin(): void {
  window.dispatchEvent(new Event('dotli:truapi-cancel-login'));
}

function ensureAuthModalLease(): void {
  if (authModalScope !== null) {
    return;
  }

  if (blockingModalCoordinator === null) {
    throw new Error(ERRORS.MISSING_MODAL_COORDINATOR);
  }
  const scope = blockingModalCoordinator.createScope();
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
    .catch(() => {
      // Closing a pending or active authentication modal disposes its lease.
    });
}
