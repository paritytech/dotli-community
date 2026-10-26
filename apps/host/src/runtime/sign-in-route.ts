// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The seam between the auth controller, which owns the sign-in modal, and the one route a page signs in by. A route
// reaches the modal only through the port it is given.

import type { AuthModalView } from '../state/auth-modal.js';
import type { LoginFailureKind } from './login-failure.js';
import type { DotliAuthState } from './session/auth-state.js';
import type { PageCancelReason } from './session-handoff/opener.js';

export type CloseAuthModalOptions = {
  /** Leaves the core's login running, for a page that signed in meanwhile. */
  skipTruapiCancel?: boolean;
  /** Why an open window round ends with the modal, `page` by default. */
  cancel?: PageCancelReason;
};

/** What a sign-in route may do with the page's sign-in modal. */
export type AuthModalPort = {
  /**
   * Opens the modal and returns whether it is open. Returns false when the modal is disabled, having cancelled the
   * core's login.
   */
  open(reason?: string, label?: string, options?: { dotSuffix?: boolean | undefined }): boolean;
  /** The modal's current lease, compared by identity, or null while none is held. */
  lease(): object | null;
  viewKind(): AuthModalView['kind'];
  show(view: AuthModalView): void;
  showFailure(kind: LoginFailureKind, reason: string): void;
  close(opts?: CloseAuthModalOptions): void;
};

/** One way a page signs in: through the sign-in window, or in place on its own core. */
export type SignInRoute = {
  /** Called only while signed out and while the saved session is reachable. */
  startLogin(reason?: string, label?: string): void;
  /** Called only while the saved session is reachable. */
  importPhrase(): void;
  /** Whether the round on show is a phrase round, so Retry imports a phrase rather than logs in. */
  retriesPhrase(): boolean;
  /** The core paired, or a product asked to log in. */
  pairing(state: Extract<DotliAuthState, { tag: 'Pairing' }>): void;
  /**
   * Whether the route's own wait is on show. That wait is the sign-in itself, so the core's login states must not
   * cover or end it. The route's own outcome ends it.
   */
  waiting(): boolean;
  /** Opens the sign-out window first, where the route has one. */
  signOut(): void;
  focus(): void;
  /** The modal closed, so the route's round ends. */
  end(reason: PageCancelReason): void;
  isValidPhrase(phrase: string): boolean;
  importPhraseInPage(phrase: string): Promise<void>;
};
