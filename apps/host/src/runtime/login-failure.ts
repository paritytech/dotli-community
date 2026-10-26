// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What a failed sign-in says to the user, from the core's failure kind and raw reason. The page's sign-in modal and
// the sign-in window's pairing both show it.

import type { PairingView } from '../state/auth-modal.js';
import type { DotliAuthState } from './session/auth-state.js';

export type LoginFailureKind = Extract<DotliAuthState, { tag: 'LoginFailed' }>['kind'];

export type FriendlyAuthError = {
  title: string;
  subtitle: string;
  detail?: string | undefined;
  retryable?: boolean | undefined;
  pending?: boolean | undefined;
};

type AuthErrorRule = {
  match: RegExp;
  title: string;
  subtitle: string;
  retryable?: boolean;
  pending?: boolean;
  hideDetail?: boolean;
};

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

/** The error view for a failed sign-in, which keeps the raw reason for bug reports. */
export function loginFailureView(kind: LoginFailureKind, reason: string): PairingView {
  const friendly = kind === 'NoFreeAllowanceSlots' ? exhaustedAllowanceError(reason) : friendlyAuthError(reason);
  return {
    kind: 'error',
    message: reason,
    retry: friendly.retryable !== false,
    pending: friendly.pending === true,
    title: friendly.title,
    subtitle: friendly.subtitle,
    detail: friendly.detail,
  };
}
