// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { requestTruapiDisconnect } from '../../auth-controller.js';
import { Button } from '../primitives/Button.js';
import { Surface } from '../primitives/Surface.js';
import { Callout } from '../primitives/Well.js';
import { sessionInitials, sessionUsername, shortenAccount, useAccount } from './account.js';
import { usePopover } from './Popover.js';
import s from './AccountContent.module.css';

function UserIcon(): JSX.Element {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function InfoIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
}

function LogOutIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

/**
 * The account popover's body (AuthButton), its own chunk: the avatar, the
 * username (or the shortened account, with a hint that the account has no
 * username on this network) and Log out, which asks the Rust core to
 * disconnect. Its ids follow the popover's (`#user-popover-username`, or the
 * landing page's `#landing-user-popover-username`).
 */
export function AccountContent(): JSX.Element {
  const popover = usePopover();
  const account = useAccount();
  const id = (name: string): string => `${popover.id}-${name}`;
  const username = (): string | undefined => {
    const session = account.session();
    return session === undefined ? undefined : sessionUsername(session);
  };
  const address = (): string | undefined => {
    const session = account.session();
    return session === undefined ? undefined : shortenAccount(session.identityAccountId ?? session.publicKey);
  };
  const initials = (): string | undefined => {
    const session = account.session();
    return session === undefined ? undefined : sessionInitials(session);
  };
  const name = (): string =>
    account.session() === undefined ? '' : (username() ?? address() ?? 'Connected with Polkadot Mobile');
  const onDisconnect = (): void => {
    popover.close();
    requestTruapiDisconnect();
  };
  return (
    <Surface width="sm" bare sheet={popover.sheet()} testId="account-content">
      <div class={s['identity']}>
        <span class={s['avatar']} aria-hidden="true">
          <Show when={initials()} fallback={<UserIcon />}>
            {value => <>{value()}</>}
          </Show>
        </span>
        <div class={s['text']}>
          <div class={s['label']}>Welcome back</div>
          <div
            class={s['name']}
            id={id('username')}
            data-address={username() === undefined && address() !== undefined ? '' : undefined}
          >
            {name()}
          </div>
        </div>
      </div>
      {/* Explains the username-less state instead of leaving a bare
          address that reads as a rendering bug. */}
      <Show when={account.loggedIn() && (username() ?? '').length === 0}>
        <Callout icon={<InfoIcon />}>
          <span id={id('hint')}>No username found for this account on this network.</span>
        </Callout>
      </Show>
      <hr class={s['divider']} />
      <Button id={id('disconnect')} block onClick={onDisconnect}>
        <LogOutIcon />
        Log out
      </Button>
    </Surface>
  );
}
