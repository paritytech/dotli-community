// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How a topbar login's sign-in ended, read from the auth state and the page's copy of the session.

import { CANCELLED, FAILED, type LoginOutcome } from './createAuthCommands.js';
import type { HostCoreStorage } from './session/createCoreStorage.js';
import { authViews } from './session/authViews.js';
import type { DotliAuthState } from './session/types.js';

type Params = {
  /** The auth state now. */
  state: DotliAuthState;
  /** The auth state when the core answered the login's request. */
  answered: DotliAuthState;
  /** A local wallet core keeps its session in memory, so nothing is stored for it. */
  isLocalWallet: () => boolean;
  /** The page's copy, which holds the session a pairing stored. */
  storedSession: Pick<HostCoreStorage, 'readSession'>;
};

/**
 * Answers how a login's sign-in ended at `state`, or null while it goes on. A failure or a sign-out ends it only once
 * the state moved on from `answered`. A failed login is told apart before an idle one, since a failed login is idle
 * too. Rejects when the read of the page's copy failed.
 */
export async function readSignInOutcome({
  state,
  answered,
  isLocalWallet,
  storedSession,
}: Params): Promise<LoginOutcome | null> {
  const account = authViews.getSignedInSession(state);
  if (account !== null) {
    if (isLocalWallet()) {
      return { kind: 'paired', account };
    }
    const read = await storedSession.readSession();
    if (read.status === 'failed') {
      throw new Error('The paired session could not be read back', { cause: read.error });
    }
    return read.blob === null ? null : { kind: 'paired', account };
  }
  switch (authViews.getLoginStep(state)?.step) {
    case 'failed':
      return state === answered ? null : FAILED;
    case 'pairing':
    case 'authenticating':
      return null;
    case undefined:
      break;
  }
  if (authViews.isSignInIdle(state)) {
    return state === answered ? null : CANCELLED;
  }
  return null;
}
