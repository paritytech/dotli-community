// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { AuthPresenter, AuthState } from '@parity/truapi-host';
import { sessionState, type PairingPresentation, type SessionState } from './createSessionState.js';

type Params = Omit<PairingPresentation, 'label'> & {
  /** Whether the core is still in service. Always by default. */
  isInService?: (() => boolean) | undefined;
  /** Where each state goes. The page's session state by default. */
  session?: Pick<SessionState, 'reportCoreAuthState'>;
};

/**
 * Hands each state the core reports to session state, with how this core's pairing presents itself. A core out of
 * service is silent, so a retired core still held by a lease cannot overwrite what its replacement reports.
 */
export function createAuthStateChanged(
  label: string,
  { dotSuffix, hostGlobal, isInService = () => true, session = sessionState }: Params = {},
): Required<AuthPresenter>['authStateChanged'] {
  const pairing = { label, dotSuffix, hostGlobal };

  function authStateChanged(state: AuthState): void {
    if (!isInService()) {
      return;
    }
    session.reportCoreAuthState(state, pairing);
  }

  return authStateChanged;
}
