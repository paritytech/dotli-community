// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { authStore, loggedInStore } from '../runtime/state/auth.js';
import { logout, startLogin } from '../runtime/auth-controller.js';
import { walletModeStore } from '../runtime/state/wallet-mode.js';
import { useStore } from '@dotli/ui';
import { AccountItem } from '../components/topbar/items.js';
import { authModalStore, setAuthModalTrigger } from '../state/auth-modal.js';
import { useAccount } from './account.js';

/** The account button bound to the session, as the topbar and the landing page's corner show it. */
export function AccountButton(props: { idPrefix?: string; showName?: boolean }): JSX.Element {
  const account = useAccount({ auth: authStore, loggedIn: loggedInStore, walletMode: walletModeStore });
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
    />
  );
}
