// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * dot.li's own session window requests and result, and the window channel seam both sides talk through. Parsers accept
 * exactly the documented shapes and return null for anything else.
 */

import type { Network } from '@dotli/config';
import { isValidNetwork } from '@dotli/config/networks';
import { isLocalWalletEntropy, isLocalWalletIdentity, type LocalWalletIdentity } from '@dotli/protocol';
import { listen } from '@dotli/shared';
import { asRecord, PROTOCOL_VERSION, requestUrl, type SessionRequest } from './session-protocol.js';

/**
 * What a round asks the window for. `resume` takes a sign-in the page knows exists elsewhere, which the window sends at
 * once when the main store holds one, and starts a new sign-in when it holds none.
 */
export type SignInIntent = 'signin' | 'phrase' | 'resume';

function isSignInIntent(value: unknown): value is SignInIntent {
  return value === 'signin' || value === 'phrase' || value === 'resume';
}

export interface SessionResult {
  session: { blob: string; uiState: string | null } | null;
  localWallet: { entropy: Uint8Array; identity: LocalWalletIdentity | null } | null;
}

/** The part of a `Window` either side talks to. */
export interface WindowHandle {
  postMessage(message: unknown, targetOrigin: string): void;
  focus(): void;
  close(): void;
  readonly closed: boolean;
}

export interface MessageEventLike {
  data: unknown;
  origin: string;
  source: unknown;
}

/** Hears the page's own `message` events until the returned stop. */
export function listenToMessages(handler: (event: MessageEventLike) => void): () => void {
  return listen(window, 'message', handler);
}

function isSession(value: unknown): value is SessionResult['session'] {
  if (value === null) {
    return true;
  }
  const r = asRecord(value);
  return (
    r !== null &&
    typeof r['blob'] === 'string' &&
    r['blob'] !== '' &&
    (r['uiState'] === null || typeof r['uiState'] === 'string')
  );
}

function isLocalWallet(value: unknown): value is SessionResult['localWallet'] {
  if (value === null) {
    return true;
  }
  const r = asRecord(value);
  if (r === null || !(r['entropy'] instanceof Uint8Array) || !isLocalWalletEntropy(r['entropy'])) {
    return false;
  }
  return r['identity'] === null || isLocalWalletIdentity(r['identity']);
}

/** The window's result as a page reads it, or null when `value` is not one. */
export function parseSessionResult(value: unknown): SessionResult | null {
  const r = asRecord(value);
  if (r === null || !isSession(r['session']) || !isLocalWallet(r['localWallet'])) {
    return null;
  }
  return { session: r['session'], localWallet: r['localWallet'] };
}

/** What a first-party window reads from its request URL. */
export type WindowRequest =
  | { route: 'auth'; net: Network; round: string; intent: SignInIntent }
  | { route: 'signout'; net: Network; round: string; notified: boolean };

/** What `/s/signout` sends as its result, since it ends a session and has none to hand over. */
export const SIGNED_OUT_RESULT: Readonly<Record<string, never>> = {};

/** The sign-in window's request URL on `origin`. */
export function signInWindowUrl(intent: SignInIntent, net: Network, round: string, origin: string): string {
  return requestUrl(origin, 'auth', { v: PROTOCOL_VERSION, net, round, intent });
}

/** The sign-out window's request URL on `origin`. `notified` says the page already told the phone. */
export function signOutWindowUrl(notified: boolean, net: Network, round: string, origin: string): string {
  return requestUrl(origin, 'signout', { v: PROTOCOL_VERSION, net, round, ...(notified ? { notified } : {}) });
}

/** The first-party request `request` makes, or null when it breaks the contract. Unknown fields are ignored. */
export function parseWindowRequest(request: SessionRequest): WindowRequest | null {
  const { route, v, net, round, params } = request;
  const { intent, notified } = params;
  if (v !== PROTOCOL_VERSION || net === null || !isValidNetwork(net)) {
    return null;
  }
  if (route === 'signout') {
    return { route, net, round, notified: notified === true };
  }
  // The site list answers no page, and only sites send transactions, so a request on either path is none of dot.li's
  // own.
  if (route === 'manage' || route === 'sign') {
    return null;
  }
  return isSignInIntent(intent) ? { route, net, round, intent } : null;
}
