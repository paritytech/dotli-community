// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, lazy, onSettled, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { startLogin } from '../../auth-controller.js';
import { getAuthState } from '../../state/auth.js';
import { authModalStore, setAuthModalTrigger } from '../../state/auth-modal.js';
import { Popover } from '../floating/Popover.js';
import { Button } from '../primitives/Button.js';
import { useStore } from '../use-store.js';
import { sessionDisplayName, sessionInitials, useAccount, UserIcon } from './account.js';
import { TOPBAR_PRIORITY } from './topbar/fit.js';
import { TopbarItem } from './topbar/TopbarItem.js';
import s from './AuthButton.module.css';

/** The debug-only test wallet's avatar: a wallet on amber, whatever the session. */
function ExperimentalWalletBadge(): JSX.Element {
  return (
    <span class={[s['avatar'], s['experimental']].join(' ')} data-testid="user-badge-experimental">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
      >
        <path d="M20 8V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15v12H5a2 2 0 0 1-2-2V6" />
        <path d="M20 12h-4a2 2 0 0 0 0 4h4" />
      </svg>
    </span>
  );
}

/** The popover's body, its own chunk. */
const Account = lazy(() => import('./AccountContent.js'), { export: 'AccountContent' });

/**
 * The topbar's auth button (`#auth-button`) and the logged-in account's
 * popover (`#user-popover`, a floating Popover whose body, AccountContent, is
 * its own chunk; a bottom sheet on phones), an item of the topbar's action group
 * (see TopbarActions.tsx) that never collapses into More. The host page
 * renders it logged out at build time, and it shows the session once
 * hydrated. The landing page (components/landing/) renders it too, in its
 * corner.
 *
 * Logged out, it is a Sign in button and a click starts a login. Logged in,
 * it shows the account's avatar: its initials, or the person icon
 * (`data-anon`) without a username, and with `showName` the account's name
 * beside it. A click toggles the user popover while the auth state is
 * `Connected`, and starts a login, which opens the auth modal, in any other
 * state (a pairing started while logged in included). Its trigger ARIA
 * follows the click, like a Radix Popover.Trigger or Dialog.Trigger:
 * `aria-haspopup="dialog"`, with `aria-controls` and `aria-expanded` for the
 * user popover while `Connected` (the button is the Popover's trigger then,
 * which writes them), else for the auth modal (`#auth-modal-backdrop`, open
 * as authModalStore says, written here).
 *
 * With the debug-only experimental test wallet active, it shows the wallet
 * badge instead, and a click opens the debug panel's Wallet tab
 * (`dotli:wallet-open`, `aria-controls="td-wallet-view"`) rather than the
 * popover, the auth modal or a Mobile login.
 *
 * `idPrefix` sets another instance's ids apart (the landing page's, whose
 * page also holds the topbar's build-time markup).
 */
export function AuthButton(props: { idPrefix?: string | undefined; showName?: boolean | undefined }): JSX.Element {
  const id = (name: string): string => `${props.idPrefix ?? ''}${name}`;
  const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  const account = useAccount();
  const authModal = useStore(authModalStore);
  /**
   * A click toggles the user popover, else opens the auth modal (see
   * onClick), so the ARIA says so.
   */
  const opensPopover = (): boolean => !account.experimental() && account.connected();
  /** The name beside the avatar, with `showName`: the username, else the shortened account. */
  const shownName = (): string | undefined => {
    const session = props.showName === true && account.loggedIn() ? account.session() : undefined;
    return session === undefined ? undefined : sessionDisplayName(session);
  };
  const label = (): string =>
    account.experimental()
      ? 'Open Wallet tab — experimental test wallet'
      : account.loggedIn()
        ? 'Account'
        : 'Sign in with Polkadot Mobile';
  // The visible text (initials, then name) starts the button's name, so
  // speech input can use it (WCAG 2.5.3).
  const ariaLabel = (): string => {
    if (account.experimental()) {
      return label();
    }
    const session = account.loggedIn() ? account.session() : undefined;
    const initials = session === undefined ? undefined : sessionInitials(session);
    const visible = [initials, shownName()].filter(part => part !== undefined).join(' ');
    return visible === '' ? label() : `${visible}, account`;
  };
  // The auth modal's trigger, while mounted (see setAuthModalTrigger).
  onSettled(() => {
    const el = untrack(button);
    return el === undefined ? undefined : setAuthModalTrigger(el);
  });
  // The experimental test wallet's click opens the debug panel's Wallet tab,
  // whatever its auth state, so an unavailable wallet stays reachable without
  // entering Mobile pairing. Otherwise, while connected the click is the
  // popover's (the trigger's own listener), else it starts the login.
  const onClick = (): void => {
    if (account.experimental()) {
      window.dispatchEvent(new Event('dotli:wallet-open'));
    } else if (getAuthState().tag !== 'Connected') {
      startLogin();
    }
  };

  return (
    <>
      <TopbarItem
        name="auth"
        label={label()}
        icon={UserIcon}
        priority={TOPBAR_PRIORITY.auth}
        activate={() => button()?.click()}
        separated
      >
        {/* One element across login and logout, so the auth modal keeps its trigger. */}
        <Button
          ref={setButton}
          onClick={onClick}
          id={id('auth-button')}
          title={label()}
          aria-label={ariaLabel()}
          aria-haspopup={opensPopover() || account.experimental() ? undefined : 'dialog'}
          aria-expanded={opensPopover() || account.experimental() ? undefined : authModal().open ? 'true' : 'false'}
          aria-controls={account.experimental() ? 'td-wallet-view' : opensPopover() ? undefined : 'auth-modal-backdrop'}
          variant={account.experimental() || account.loggedIn() ? 'secondary' : 'primary'}
          class={
            account.experimental()
              ? [s['chip'], s['avatarOnly']].join(' ')
              : account.loggedIn()
                ? [s['chip'], shownName() === undefined ? s['avatarOnly'] : undefined].join(' ').trim()
                : s['signIn']
          }
        >
          <Show when={!account.experimental()} fallback={<ExperimentalWalletBadge />}>
            <Show
              when={account.loggedIn() && account.session()}
              fallback={
                <>
                  <UserIcon />
                  <span class={s['label']}>Sign in</span>
                </>
              }
            >
              {session => (
                <>
                  <span
                    class={s['avatar']}
                    data-testid="user-badge"
                    data-anon={sessionInitials(session()) === undefined ? '' : undefined}
                  >
                    <Show when={sessionInitials(session())} fallback={<UserIcon />}>
                      {initials => <>{initials()}</>}
                    </Show>
                  </span>
                  <Show when={shownName()}>{name => <span class={s['name']}>{name()}</span>}</Show>
                </>
              )}
            </Show>
          </Show>
        </Button>
      </TopbarItem>
      <Popover
        id={id('user-popover')}
        title="Account"
        trigger={opensPopover() ? button() : undefined}
        class={s['popover']}
        preload={Account.preload}
      >
        <Account />
      </Popover>
    </>
  );
}
