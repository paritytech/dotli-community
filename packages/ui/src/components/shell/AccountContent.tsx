// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { requestTruapiDisconnect } from '../../auth-controller.js';
import { walletModeStore } from '../../state/wallet-mode.js';
import { Button } from '../primitives/Button.js';
import { Chip } from '../primitives/Chip.js';
import { Surface } from '../primitives/Surface.js';
import { Callout, InfoIcon } from '../primitives/Well.js';
import { sessionDisplayName, sessionInitials, sessionUsername, useAccount, UserIcon } from './account.js';
import { usePopover } from '../floating/Popover.js';
import { useStore } from '../use-store.js';
import s from './AccountContent.module.css';

function LogOutIcon(): JSX.Element {
  return (
    <svg
      class={s['icon']}
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
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9" />
    </svg>
  );
}

/** The account popover's body, its own chunk. */
export function AccountContent(): JSX.Element {
  const popover = usePopover();
  const account = useAccount();
  const walletMode = useStore(walletModeStore);
  const local = (): boolean => walletMode().mode === 'local';
  const id = (name: string): string => `${popover.id}-${name}`;
  const username = (): string | undefined => {
    const session = account.session();
    return session === undefined ? undefined : sessionUsername(session);
  };
  const displayName = (): string | undefined => {
    const session = account.session();
    return session === undefined ? undefined : sessionDisplayName(session);
  };
  const initials = (): string | undefined => {
    const session = account.session();
    return session === undefined ? undefined : sessionInitials(session);
  };
  const name = (): string =>
    account.session() === undefined
      ? ''
      : (displayName() ?? (local() ? 'Connected' : 'Connected with Polkadot Mobile'));
  const onDisconnect = (): void => {
    popover.close();
    requestTruapiDisconnect();
  };
  return (
    <Surface width="sm" class={s['panel']} testId="account-content">
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
            data-address={username() === undefined && displayName() !== undefined ? '' : undefined}
          >
            {name()}
          </div>
          {/* The keys live in this browser, not in Polkadot App. */}
          <Show when={local()}>
            <Chip tone="warn" class={s['local']} testId="account-local">
              Local account
            </Chip>
          </Show>
        </div>
      </div>
      {/* A bare address with no explanation reads as a rendering bug. */}
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
