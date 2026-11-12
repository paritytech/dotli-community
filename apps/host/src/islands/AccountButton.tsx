// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { authState } from '../runtime/state/authState.js';
import { authControl } from '../runtime/authControl.js';
import { sessionElsewhereState } from '../runtime/state/sessionElsewhereState.js';
import { signingOutState } from '../runtime/state/signingOutState.js';
import { walletModeState } from '../runtime/state/walletModeState.js';
import { getProtocolOrigin } from '@dotli/protocol';
import { getRouteUrl } from '../runtime/sessionHandoff/sessionRoute.js';
import { useStore } from '@dotli/stores-solid';
import { AccountItem } from '../components/account/AuthButton.js';
import { authModalState } from '../state/authModalState.js';
import { useAccount } from './account.js';

/** The account button bound to the session, as the topbar and the landing page's corner show it. */
export function AccountButton(props: { idPrefix?: string; showName?: boolean }): JSX.Element {
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
