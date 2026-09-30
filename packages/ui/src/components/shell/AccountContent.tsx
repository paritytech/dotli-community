// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { requestTruapiDisconnect } from '../../auth-controller.js';
import { sessionUsername, shortenAccount, useAccount } from './account.js';
import { usePopover } from './Popover.js';

/**
 * The account popover's body (AuthButton), its own chunk: the username (or
 * the shortened account, with a hint that the account has no username on
 * this network) and Log out, which asks the Rust core to disconnect. Its ids
 * follow the popover's (`#user-popover-username`, or the landing page's
 * `#landing-user-popover-username`).
 */
export function AccountContent(): JSX.Element {
  const popover = usePopover();
  const account = useAccount();
  const id = (name: string): string => `${popover.id}-${name}`;
  const username = (): string | undefined => {
    const session = account.session();
    return session === undefined ? undefined : sessionUsername(session);
  };
  const name = (): string => {
    const session = account.session();
    if (session === undefined) {
      return '';
    }
    return (
      sessionUsername(session) ??
      shortenAccount(session.identityAccountId ?? session.publicKey) ??
      'Connected with Polkadot Mobile'
    );
  };
  const onDisconnect = (): void => {
    popover.close();
    requestTruapiDisconnect();
  };
  return (
    <>
      <div class="user-popover-name">
        <div class="label">Welcome back</div>
        <div class="name" id={id('username')}>
          {name()}
        </div>
        {/* Explains the username-less state instead of leaving a bare
            address that reads as a rendering bug. */}
        <Show when={account.loggedIn() && (username() ?? '').length === 0}>
          <div id={id('hint')} class="user-popover-hint">
            No username found for this account on this network.
          </div>
        </Show>
      </div>
      <div class="user-popover-divider" />
      <button onClick={onDisconnect} class="user-popover-disconnect" id={id('disconnect')}>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" y1="12" x2="9" y2="12" />
        </svg>
        Log out
      </button>
    </>
  );
}
