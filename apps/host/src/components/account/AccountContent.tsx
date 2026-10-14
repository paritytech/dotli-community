// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { InfoIcon, LogOutIcon } from '@dotli/ui/icons';
import { Button, Callout, Chip, Surface, usePopover } from '@dotli/ui';
import { AccountAvatar } from './AccountAvatar.js';
import { sessionDisplayName, sessionUsername } from './account-names.js';
import type { Account } from './account.js';
import s from './AccountContent.module.css';

export interface AccountContentProps {
  account: Account;
  onLogout: () => void;
}

/** The account popover's body, its own chunk. */
export function AccountContent(props: AccountContentProps): JSX.Element {
  const popover = usePopover();
  const local = (): boolean => props.account.local();
  const id = (name: string): string => `${popover.id}-${name}`;
  const username = (): string | undefined => {
    const session = props.account.session();
    return session === undefined ? undefined : sessionUsername(session);
  };
  const displayName = (): string | undefined => {
    const session = props.account.session();
    return session === undefined ? undefined : sessionDisplayName(session);
  };
  const name = (): string =>
    props.account.session() === undefined
      ? ''
      : (displayName() ?? (local() ? 'Connected' : 'Connected with Polkadot Mobile'));
  const onDisconnect = (): void => {
    popover.close();
    props.onLogout();
  };
  return (
    <Surface width="sm" padded testId="account-content">
      <div class={s['identity']}>
        <AccountAvatar session={props.account.session()} size="lg" decorative />
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
      <Show when={props.account.loggedIn() && (username() ?? '').length === 0}>
        <Callout icon={InfoIcon}>
          <span id={id('hint')}>No username found for this account on this network.</span>
        </Callout>
      </Show>
      <hr class={s['divider']} />
      <Button id={id('disconnect')} block onClick={onDisconnect}>
        <LogOutIcon class={s['icon']} />
        Log out
      </Button>
    </Surface>
  );
}
