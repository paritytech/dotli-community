// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The questions code outside the session layer asks of the auth state. Code outside the session layer reads the state
// through these views, never by its tag, so a new member is mapped here once.

import type { LoginFailureKind } from '@parity/truapi-host';
import type { TruapiSessionUiState } from './parseUiStateCache.js';
import type { DotliAuthState, PairingState } from './types.js';

/** What the page knows of the saved session: still reading it, unable to read it, or known. */
export type SessionKnowledge = 'reading' | 'unreachable' | 'known';

/**
 * The login step on show: a pairing under way, its confirmation, or a login that failed. Its tag is `step`, as the
 * failed step carries the core's own `kind` field.
 */
export type LoginStep =
  | { step: 'pairing'; pairing: PairingState }
  | { step: 'authenticating' }
  | { step: 'failed'; kind: LoginFailureKind; reason: string };

/** The questions code outside the session layer asks of the auth state. */
export const authViews = {
  getSessionKnowledge,
  isAwaitingSavedSession,
  isSessionUnreachable,
  getSignedInSession,
  getLoginStep,
  isSignInIdle,
  isLoginRunning,
  getLoggedInChange,
};

/** What the page knows of the saved session in `state`. Never throws. */
function getSessionKnowledge(state: DotliAuthState): SessionKnowledge {
  switch (state.tag) {
    case 'Restoring':
      return 'reading';
    case 'Unreachable':
      return 'unreachable';
    case 'Disconnected':
    case 'Pairing':
    case 'Authenticating':
    case 'Connected':
    case 'LoginFailed':
      return 'known';
  }
}

/**
 * Whether the saved session is not yet known or could not be read, the only states a read of it may end.
 * Never throws.
 */
function isAwaitingSavedSession(state: DotliAuthState): boolean {
  switch (getSessionKnowledge(state)) {
    case 'reading':
    case 'unreachable':
      return true;
    case 'known':
      return false;
  }
}

/** Whether the saved session could not be read, so a sign-in waits for a read that answers. Never throws. */
function isSessionUnreachable(state: DotliAuthState): boolean {
  switch (getSessionKnowledge(state)) {
    case 'unreachable':
      return true;
    case 'reading':
    case 'known':
      return false;
  }
}

/** The session `state` shows signed in, or null when it shows none. Never throws. */
function getSignedInSession(state: DotliAuthState): TruapiSessionUiState | null {
  switch (state.tag) {
    case 'Connected':
      return state.session;
    case 'Restoring':
    case 'Unreachable':
    case 'Disconnected':
    case 'Pairing':
    case 'Authenticating':
    case 'LoginFailed':
      return null;
  }
}

/** The login step `state` shows, or null when no login is on show. Never throws. */
function getLoginStep(state: DotliAuthState): LoginStep | null {
  switch (state.tag) {
    case 'Pairing':
      return { step: 'pairing', pairing: state };
    case 'Authenticating':
      return { step: 'authenticating' };
    case 'LoginFailed':
      return { step: 'failed', kind: state.kind, reason: state.reason };
    case 'Restoring':
    case 'Unreachable':
    case 'Disconnected':
    case 'Connected':
      return null;
  }
}

/**
 * Whether the session is known, with no session on show and no pairing running, so a sign-in may start.
 * Never throws.
 */
function isSignInIdle(state: DotliAuthState): boolean {
  switch (state.tag) {
    case 'Disconnected':
    case 'LoginFailed':
      return true;
    case 'Restoring':
    case 'Unreachable':
    case 'Pairing':
    case 'Authenticating':
    case 'Connected':
      return false;
  }
}

/**
 * Whether a core login is under way that a cancel must end: true while pairing or authenticating, false otherwise.
 * Never throws.
 */
function isLoginRunning(state: DotliAuthState): boolean {
  switch (state.tag) {
    case 'Pairing':
    case 'Authenticating':
      return true;
    case 'Restoring':
    case 'Unreachable':
    case 'Disconnected':
    case 'Connected':
    case 'LoginFailed':
      return false;
  }
}

/** What `state` says of being logged in: true, false, or null when it leaves it as it was. Never throws. */
function getLoggedInChange(state: DotliAuthState): boolean | null {
  switch (state.tag) {
    case 'Connected':
      return true;
    case 'Disconnected':
    case 'Unreachable':
      return false;
    case 'Restoring':
    case 'Pairing':
    case 'Authenticating':
    case 'LoginFailed':
      return null;
  }
}
