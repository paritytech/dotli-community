// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Accessor } from 'solid-js';
import type { TruapiSessionUiState } from '../../runtime/session/parseUiStateCache.js';
import type { SessionKnowledge } from '../../runtime/session/authViews.js';

/** A signed-in session as the account views show it. */
export type AccountSession = Omit<TruapiSessionUiState, 'connected'>;

/** The signed-in account as the account views read it. */
export type Account = {
  /** True from `Connected` until `Disconnected`. */
  loggedIn: Accessor<boolean>;
  /**
   * The last connected session, kept through the states in between.
   * A login whose session the page never saw shows as a bare session with no names.
   */
  session: Accessor<AccountSession | undefined>;
  /** True while the auth state is `Connected`. */
  connected: Accessor<boolean>;
  /** What the page knows of the saved session. */
  knowledge: Accessor<SessionKnowledge>;
  /** True while a sign-out waits for the sign-out window. */
  signingOut: Accessor<boolean>;
  /** True while the keys live in this browser, not in Polkadot App. */
  local: Accessor<boolean>;
  /** True while signed out here and a sign-in made elsewhere on the site waits to be continued. */
  elsewhere: Accessor<boolean>;
};

/**
 * What the button's face shows: the account, as its avatar when it has a session to show, the sign-in prompt, which may
 * continue a sign-in made elsewhere, or the alert of a sign-in that cannot be reached.
 */
export type AuthButtonFace =
  { kind: 'account'; session: AccountSession | undefined } | { kind: 'prompt'; resumes: boolean } | { kind: 'alert' };

/** What the auth button shows: its state, which names its label, and the face it shows. */
export type AuthButtonState =
  | { kind: 'checking'; face: AuthButtonFace }
  | { kind: 'unreachable'; face: AuthButtonFace; busy: boolean }
  | { kind: 'signingOut'; face: AuthButtonFace }
  | { kind: 'resume'; face: AuthButtonFace }
  | { kind: 'signIn'; face: AuthButtonFace }
  | { kind: 'signedIn'; face: AuthButtonFace };

type AuthButtonAccount = Pick<Account, 'knowledge' | 'signingOut' | 'loggedIn' | 'elsewhere' | 'session'>;

/**
 * The auth button's state, first match wins: checking, unreachable, signing out, resume, sign in, signed in. The face is
 * the alert while the sign-in cannot be reached, else the account while logged in, else the prompt. Never throws.
 */
export function getAuthButtonState(account: AuthButtonAccount): AuthButtonState {
  switch (account.knowledge()) {
    case 'reading':
      return { kind: 'checking', face: getAccountFace(account) };
    case 'unreachable':
      return { kind: 'unreachable', face: { kind: 'alert' }, busy: account.signingOut() };
    case 'known':
      return getKnownState(account);
  }
}

function getKnownState(account: AuthButtonAccount): AuthButtonState {
  const face = getAccountFace(account);
  if (account.signingOut()) {
    return { kind: 'signingOut', face };
  }
  if (!account.loggedIn() && account.elsewhere()) {
    return { kind: 'resume', face };
  }
  if (!account.loggedIn()) {
    return { kind: 'signIn', face };
  }
  return { kind: 'signedIn', face };
}

function getAccountFace(account: AuthButtonAccount): AuthButtonFace {
  if (account.loggedIn()) {
    return { kind: 'account', session: account.session() };
  }
  return { kind: 'prompt', resumes: account.elsewhere() };
}
