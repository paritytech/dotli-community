// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The postMessage payloads of a sign-in window round and of a sign-out window, the window URL and the page's listener
 * for them. Parsers accept exactly the documented shapes and return null for anything else.
 */

import type { Network } from '@dotli/config';
import { isLocalWalletEntropy, isLocalWalletIdentity, type LocalWalletIdentity } from '@dotli/protocol';
import { listen } from '@dotli/shared';
import { SESSION_WINDOW_PATH } from '../../shell-route.js';

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

/**
 * A message the window sends its opener. `signed-out-read` is the sign-out window telling its opener it has read what
 * it ends, so the opener may clear its own copy. It carries nothing.
 */
export type WindowMessage =
  | { type: 'dotli:session:ready' }
  | { type: 'dotli:session:signed-out-read' }
  | { type: 'dotli:session:result'; round: string; result: SessionResult }
  | { type: 'dotli:session:refused'; round: string };

/** The sign-out window's word to its opener that it has read what it ends. */
export const SIGNED_OUT_READ: WindowMessage = { type: 'dotli:session:signed-out-read' };

export interface OpenerMessage {
  type: 'dotli:session:hello';
  round: string;
  intent: SignInIntent;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

function parseResult(value: unknown): SessionResult | null {
  const r = asRecord(value);
  if (r === null || !isSession(r['session']) || !isLocalWallet(r['localWallet'])) {
    return null;
  }
  return { session: r['session'], localWallet: r['localWallet'] };
}

/** The window's message to the opener, or null when `data` is not one. */
export function parseWindowMessage(data: unknown): WindowMessage | null {
  const r = asRecord(data);
  if (r === null) {
    return null;
  }
  const type = r['type'];
  if (type === 'dotli:session:ready' || type === 'dotli:session:signed-out-read') {
    return { type };
  }
  const round = r['round'];
  if (typeof round !== 'string') {
    return null;
  }
  if (type === 'dotli:session:refused') {
    return { type, round };
  }
  if (type === 'dotli:session:result') {
    const result = parseResult(r['result']);
    return result ? { type, round, result } : null;
  }
  return null;
}

/** The opener's message to the window, or null when `data` is not one. */
export function parseOpenerMessage(data: unknown): OpenerMessage | null {
  const r = asRecord(data);
  const round = r?.['round'];
  if (r?.['type'] !== 'dotli:session:hello' || typeof round !== 'string') {
    return null;
  }
  const intent = r['intent'];
  return isSignInIntent(intent) ? { type: 'dotli:session:hello', round, intent } : null;
}

/** The session window's URL on `origin`, the root origin the protocol frame uses. */
function windowUrl(query: URLSearchParams, origin: string): string {
  return `${origin}${SESSION_WINDOW_PATH}?${query}`;
}

/** The sign-in window's URL on `origin`. */
export function signInWindowUrl(intent: SignInIntent, net: Network, origin: string): string {
  return windowUrl(new URLSearchParams({ intent, net }), origin);
}

/** The sign-out window's URL on `origin`. `notified` says the page already told the phone. */
export function signOutWindowUrl(notified: boolean, net: Network, origin: string): string {
  const query = new URLSearchParams({ intent: 'signout', net });
  if (notified) {
    query.set('notified', '1');
  }
  return windowUrl(query, origin);
}

/**
 * The sign-in intent the window's URL names, which only a window with no opener goes by, since no hello reaches it. It
 * only picks the first view, so a URL that names anything else signs in, `resume` included, as nobody waits to take
 * what it would send.
 */
export function windowUrlIntent(search: string): SignInIntent {
  return new URLSearchParams(search).get('intent') === 'phrase' ? 'phrase' : 'signin';
}

/** What a sign-out window's URL says, or null for a window that signs in. */
export function windowUrlSignOut(search: string): { notified: boolean } | null {
  const query = new URLSearchParams(search);
  return query.get('intent') === 'signout' ? { notified: query.get('notified') === '1' } : null;
}
