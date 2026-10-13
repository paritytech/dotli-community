// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { AuthPresenter, AuthState, LoginFailureKind } from '@parity/truapi-host';
import { sessionState, type SessionState, type TruapiSessionUiState } from './session-state.js';

/**
 * The core's `AuthState` with byte fields converted for rendering, plus the pairing context the modal needs.
 * `Restoring` and `Unreachable` are the host's own. Boot has not yet read the saved session, or the read failed, so
 * the user is neither signed in nor out. The session state layer leaves both on its own.
 */
export type DotliAuthState =
  | { tag: 'Restoring' }
  | { tag: 'Unreachable' }
  | { tag: 'Disconnected' }
  | {
      tag: 'Pairing';
      deeplink: string;
      label: string;
      dotSuffix?: boolean | undefined;
      hostGlobal?: boolean | undefined;
    }
  | { tag: 'Authenticating' }
  | { tag: 'Connected'; session: TruapiSessionUiState }
  | { tag: 'LoginFailed'; kind: LoginFailureKind; reason: string };

/**
 * Hands each state the core reports to session state, with how this core's pairing presents itself. A core out of
 * service is silent, so a retired core still held by a lease cannot overwrite what its replacement reports.
 */
export function createAuthStateChanged(
  label: string,
  options: {
    dotSuffix?: boolean | undefined;
    hostGlobal?: boolean | undefined;
    inService?: (() => boolean) | undefined;
  } = {},
  session: Pick<SessionState, 'reportCoreAuthState'> = sessionState,
): Required<AuthPresenter>['authStateChanged'] {
  const pairing = { label, dotSuffix: options.dotSuffix, hostGlobal: options.hostGlobal };
  const inService = options.inService ?? (() => true);
  return (state: AuthState) => {
    if (!inService()) {
      return;
    }
    session.reportCoreAuthState(state, pairing);
  };
}
