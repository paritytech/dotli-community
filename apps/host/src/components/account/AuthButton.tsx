// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, lazy, onSettled, Show, untrack, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Button, Popover } from '@dotli/ui';
import type { MoreRow } from '@dotli/ui';
import { AccountAvatar, sessionDisplayName, sessionInitials, UserIcon } from '@dotli/ui-entities';
import type { Account } from './account.js';
import s from './AuthButton.module.css';
import { loadAccountContent } from '../../lazy.js';

const AccountPanel = lazy(loadAccountContent, { export: 'AccountContent' });

export interface AuthButtonProps {
  account: Account;
  /** Whether the auth modal is open, which the button announces while a click starts a sign-in. */
  modalOpen: Accessor<boolean>;
  /** A click while not `Connected`. */
  onSignIn: () => void;
  /** Log out in the account popover. */
  onLogout: () => void;
  /** Hands the button to the auth modal, which gives it focus back as it closes. Returns the hand back. */
  handOver?: ((button: HTMLElement) => () => void) | undefined;
  /** Keeps the landing page's ids apart from the topbar's build-time markup on the same page. */
  idPrefix?: string | undefined;
  /** Shows the name beside the initials, as the landing page does. */
  showName?: boolean | undefined;
  /** Gets the button once it is on the page. */
  buttonRef?: ((button: HTMLButtonElement) => void) | undefined;
}

/** A signed-in account by where its keys live, in this browser or in Polkadot App. */
function accountKind(account: Account): string {
  return account.loggedIn() && account.local() ? 'Local account' : 'Account';
}

/** What the button says it does in `account`'s state: its title, and its More row's label. */
function authLabel(account: Account): string {
  if (account.restoring()) {
    return 'Checking sign-in';
  }
  if (account.unreachable()) {
    return 'Reconnecting to your sign-in';
  }
  if (!account.loggedIn()) {
    return 'Sign in with Polkadot Mobile';
  }
  return accountKind(account);
}

/** The account button's More row. */
export function accountRow(props: Pick<AuthButtonProps, 'account'>): MoreRow {
  return {
    get label() {
      return authLabel(props.account);
    },
    icon: () => <UserIcon />,
  };
}

/**
 * The auth button and the account popover, in the topbar and in the landing page's corner.
 *
 * A click toggles the popover only while `Connected`, and starts a sign-in in any other state, a pairing
 * under way while logged in included. It takes no clicks while the saved session is being read or cannot be
 * reached. The trigger ARIA follows the click: the Popover writes it while `Connected`, this component writes it
 * for the auth modal otherwise.
 */
export function AuthButton(props: AuthButtonProps): JSX.Element {
  const id = (name: string): string => `${props.idPrefix ?? ''}${name}`;
  const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  const account = (): Account => props.account;
  const opensPopover = (): boolean => account().connected();
  // The keys live in this browser, not in Polkadot App.
  const local = (): boolean => account().loggedIn() && account().local();
  const shownName = (): string | undefined => {
    const session = props.showName === true && account().loggedIn() ? account().session() : undefined;
    return session === undefined ? undefined : sessionDisplayName(session);
  };
  const label = (): string => authLabel(account());
  // The visible text starts the accessible name, so speech input can use it.
  const ariaLabel = (): string => {
    const session = account().loggedIn() ? account().session() : undefined;
    const initials = session === undefined ? undefined : sessionInitials(session);
    const visible = [initials, shownName()].filter(part => part !== undefined).join(' ');
    return visible === '' ? label() : `${visible}, ${accountKind(account()).toLowerCase()}`;
  };
  onSettled(() => {
    const el = untrack(button);
    return el === undefined ? undefined : props.handOver?.(el);
  });
  // While connected the Popover's own trigger listener takes the click.
  const onClick = (): void => {
    if (!account().connected()) {
      props.onSignIn();
    }
  };

  return (
    <>
      {/* One element across login and logout, so the auth modal keeps its trigger. */}
      <Button
        ref={el => {
          setButton(el);
          props.buttonRef?.(el);
        }}
        onClick={onClick}
        id={id('auth-button')}
        loading={account().restoring() || account().unreachable()}
        title={label()}
        aria-label={ariaLabel()}
        aria-haspopup={opensPopover() ? undefined : 'dialog'}
        aria-expanded={opensPopover() ? undefined : props.modalOpen() ? 'true' : 'false'}
        aria-controls={opensPopover() ? undefined : 'auth-modal-backdrop'}
        variant={account().loggedIn() ? 'secondary' : 'primary'}
        class={
          account().loggedIn()
            ? [s['chip'], shownName() === undefined ? s['avatarOnly'] : undefined].join(' ').trim()
            : s['signIn']
        }
      >
        <Show
          when={account().loggedIn() && account().session()}
          fallback={
            <>
              <UserIcon />
              <span class={s['label']}>Sign in</span>
            </>
          }
        >
          {session => (
            <>
              <AccountAvatar session={session()} size="sm" local={local()} testId="user-badge" />
              <Show when={shownName()}>
                {name => (
                  // The space keeps the initials and the name apart in the visible text, as in the button's name.
                  <>
                    {' '}
                    <span class={s['name']}>{name()}</span>
                  </>
                )}
              </Show>
            </>
          )}
        </Show>
      </Button>
      <Popover
        id={id('user-popover')}
        title="Account"
        trigger={opensPopover() ? button() : undefined}
        class={s['popover']}
        preload={AccountPanel.preload}
      >
        <AccountPanel account={props.account} onLogout={props.onLogout} />
      </Popover>
    </>
  );
}
