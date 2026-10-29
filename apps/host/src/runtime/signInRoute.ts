// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The seam between the auth controller, which owns the sign-in modal, and the one route a page signs in by. A route
// reaches the modal only through the port it is given.

import type { AuthModalView } from '../state/authModal.js';
import type { LoginFailureKind } from './getLoginFailureView.js';
import type { DotliAuthState } from './session/types.js';
import type { PageCancelReason } from './sessionHandoff/createSessionHandoff.js';

/** Why a sign-in starts and which product it is for. */
export type StartLoginParams = {
  /** Why the sign-in was asked for, which the modal shows. */
  reason?: string | undefined;
  /** The product the sign-in is for, which the modal names. */
  label?: string | undefined;
};

/** What the modal shows when it opens. */
export type OpenAuthModalParams = StartLoginParams & {
  /** False shows the label as it is, with no active TLD added. */
  dotSuffix?: boolean | undefined;
};

/** How the modal closes. */
export type CloseAuthModalParams = {
  /** Leaves the core's login running, for a page that signed in meanwhile. */
  skipTruapiCancel?: boolean;
  /** Why an open window round ends with the modal, `page` by default. */
  cancel?: PageCancelReason;
};

/** What a sign-in route may do with the page's sign-in modal. */
export type AuthModalPort = {
  /**
   * Opens the modal and returns whether it is open. Returns false when the modal is disabled, having cancelled the
   * core's login. Never throws.
   */
  open(params?: OpenAuthModalParams): boolean;
  /** Returns the modal's current lease, compared by identity, or null while none is held. Never throws. */
  getLease(): object | null;
  /** Returns the kind of the view on show. Never throws. */
  getViewKind(): AuthModalView['kind'];
  /** Shows `view` in the modal. Never throws. */
  show(view: AuthModalView): void;
  /** Opens the modal at the error view of a failed sign-in. Never throws. */
  showFailure(kind: LoginFailureKind, reason: string): void;
  /** Closes the modal, cancelling the core's login unless `params` says not to. Never throws. */
  close(params?: CloseAuthModalParams): void;
};

/** One way a page signs in: through the sign-in window, or in place on its own core. */
export type SignInRoute = {
  /** Called only while signed out and while the saved session is reachable. Never throws. */
  startLogin(params?: StartLoginParams): void;
  /** Called only while the saved session is reachable. Never throws. */
  importPhrase(): void;
  /** Whether the round on show is a phrase round, so Retry imports a phrase rather than logs in. Never throws. */
  isPhraseRound(): boolean;
  /** The core paired, or a product asked to log in. Never throws. */
  pairing(state: Extract<DotliAuthState, { tag: 'Pairing' }>): void;
  /**
   * Whether the route's own wait is on show. That wait is the sign-in itself, so the core's login states must not
   * cover or end it. The route's own outcome ends it. Never throws.
   */
  isWaiting(): boolean;
  /** Opens the sign-out window first, where the route has one. Never throws. */
  signOut(): void;
  /** Brings the route's sign-in window to the front, where it has one. Never throws. */
  focus(): void;
  /** The modal closed, so the route's round ends. Never throws. */
  end(reason: PageCancelReason): void;
  /** Whether the modal's phrase view takes `phrase`. Never throws. */
  isValidPhrase(phrase: string): boolean;
  /**
   * Uses the wallet of `phrase`, which reloads the page. Rejects when the phrase import has not loaded, when the phrase
   * is not valid, or when the wallet could not be saved.
   */
  importPhraseInPage(phrase: string): Promise<void>;
};
