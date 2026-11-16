// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { ExternalWindowIcon, GlobeIcon, InfoIcon, LogOutIcon } from '@dotli/ui/icons';
import { Button, Callout, Chip, Surface, usePopover } from '@dotli/ui';
import { AccountAvatar } from './AccountAvatar.js';
import { sessionDisplayName, sessionUsername } from './accountNames.js';
import type { Account } from './account.js';
import s from './AccountContent.module.css';

export type AccountContentProps = {
  account: Account;
  onLogout: () => void;
  /** The signed-in sites page. The link shows only with it and a signed-in account. */
  sitesUrl?: string | undefined;
};

/** The account popover's body, its own chunk. */
export function AccountContent(props: AccountContentProps): JSX.Element {
  const popover = usePopover();
  const id = (name: string): string => `${popover.id}-${name}`;
  const username = (): string | undefined => {
    const session = props.account.session();
    return session === undefined ? undefined : sessionUsername(session);
  };
  const displayName = (): string | undefined => {
    const session = props.account.session();
    return session === undefined ? undefined : sessionDisplayName(session);
  };
  // An account with no name says where it is connected, in a line short enough to stay on one.
  const unnamed = (): boolean => props.account.session() !== undefined && displayName() === undefined;
  const name = (): string =>
    props.account.session() === undefined
      ? ''
      : (displayName() ?? (props.account.local() ? 'Local account' : 'Polkadot App'));
  const hinted = (): boolean => props.account.loggedIn() && username() === undefined;
  const onDisconnect = (): void => {
    popover.close();
    props.onLogout();
  };
  return (
    <Surface width="sm" padded testId="account-content">
      <div class={s['identity']}>
        <AccountAvatar session={props.account.session()} size="lg" decorative testId="account-avatar" />
        <div class={s['text']}>
          <div class={s['label']}>{unnamed() ? 'Connected with' : 'Welcome back'}</div>
          <div
            class={s['name']}
            id={id('username')}
            data-address={username() === undefined && displayName() !== undefined ? '' : undefined}
          >
            {name()}
          </div>
          {/* The keys live in this browser, not in Polkadot App. An unnamed account already says so as its name. */}
          <Show when={props.account.local() && !unnamed()}>
            <Chip tone="warn" class={s['local']} testId="account-local">
              Local account
            </Chip>
          </Show>
        </div>
      </div>
      {/* A bare address with no explanation reads as a rendering bug. */}
      <Show when={hinted()}>
        <Callout icon={InfoIcon}>
          <span id={id('hint')}>No username found for this account on this network.</span>
        </Callout>
      </Show>
      <Show when={props.account.loggedIn() ? props.sitesUrl : undefined}>
        {url => (
          <a
            class={s['sites']}
            href={url()}
            target="_blank"
            rel="noopener"
            data-testid="account-sites"
            data-initial-focus=""
          >
            <GlobeIcon class={s['icon']} />
            <span class={s['sitesLabel']}>Signed-in sites</span>
            <ExternalWindowIcon class={s['icon']} />
          </a>
        )}
      </Show>
      <hr class={s['divider']} />
      <Button id={id('disconnect')} block onClick={onDisconnect}>
        <LogOutIcon class={s['icon']} />
        Sign out
      </Button>
    </Surface>
  );
}
