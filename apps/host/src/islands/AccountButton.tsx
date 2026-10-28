// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { authState } from '../runtime/state/authState.js';
import { logout, startLogin } from '../runtime/authController.js';
import { sessionElsewhereState } from '../runtime/state/sessionElsewhereState.js';
import { signingOutState } from '../runtime/state/signingOutState.js';
import { walletModeState } from '../runtime/state/walletModeState.js';
import { getProtocolOrigin } from '@dotli/protocol';
import { getRouteUrl } from '../runtime/sessionHandoff/sessionRoute.js';
import { useStore } from '@dotli/ui';
import { AccountItem } from '../components/account/AuthButton.js';
import { authModalStore, setAuthModalTrigger } from '../state/authModal.js';
import { useAccount } from './account.js';

/** The account button bound to the session, as the topbar and the landing page's corner show it. */
export function AccountButton(props: { idPrefix?: string; showName?: boolean }): JSX.Element {
  const account = useAccount({
    auth: authState.store,
    loggedIn: authState.loggedInStore,
    walletMode: walletModeState.store,
    signingOut: signingOutState.store,
    elsewhere: sessionElsewhereState.store,
  });
  const modalOpen = useStore(authModalStore, state => state.open);
  return (
    <AccountItem
      account={account}
      modalOpen={modalOpen}
      onSignIn={() => {
        startLogin();
      }}
      onLogout={() => {
        logout();
      }}
      handOver={setAuthModalTrigger}
      idPrefix={props.idPrefix}
      showName={props.showName}
      sitesUrl={getRouteUrl(getProtocolOrigin(), 'manage')}
    />
  );
}
