// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { authState } from '../session/authState.js';
import { authControl } from '../signIn/authControl.js';
import { sessionElsewhereState } from '../session/sessionElsewhereState.js';
import { signingOutState } from '../signIn/signingOutState.js';
import { walletModeState } from '../session/walletModeState.js';
import { getProtocolOrigin } from '@dotli/protocol';
import { getRouteUrl } from '../../../kit/sessionRoute.js';
import { useStore } from '@dotli/stores-solid';
import { AccountItem } from './AuthButton.js';
import { authModalState } from '../signIn/authModalState.js';
import { useAccount } from './useAccount.js';

/** The account button bound to the session, as the topbar and the landing page's corner show it. */
export function AccountButtonIsland(props: { idPrefix?: string; showName?: boolean }): JSX.Element {
  const account = useAccount({
    auth: authState.store,
    loggedIn: authState.loggedInStore,
    local: walletModeState.localStore,
    signingOut: signingOutState.store,
    elsewhere: sessionElsewhereState.store,
  });
  const modalOpen = useStore(authModalState.store, state => state.open);
  return (
    <AccountItem
      account={account}
      modalOpen={modalOpen}
      onSignIn={() => {
        authControl.startLogin();
      }}
      onLogout={() => {
        authControl.logout();
      }}
      handOver={authModalState.setTrigger}
      idPrefix={props.idPrefix}
      showName={props.showName}
      sitesUrl={getRouteUrl(getProtocolOrigin(), 'manage')}
    />
  );
}
