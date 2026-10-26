// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Accessor } from 'solid-js';
import type { TruapiSessionUiState } from '../../runtime/session/session-state.js';

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
  /** True until boot has read the saved session. */
  restoring: Accessor<boolean>;
  /** True while the saved session could not be read. */
  unreachable: Accessor<boolean>;
  /** True while a sign-out waits for the sign-out window. */
  signingOut: Accessor<boolean>;
  /** True while the keys live in this browser, not in Polkadot App. */
  local: Accessor<boolean>;
  /** True while signed out here and a sign-in made elsewhere on the site waits to be continued. */
  elsewhere: Accessor<boolean>;
};
