// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { lazy, onSettled, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { startLogin } from '../../auth-controller.js';
import { getAuthState } from '../../state/auth.js';
import { authModalStore, setAuthModalTrigger } from '../../state/auth-modal.js';
import { useStore } from '../use-store.js';
import { sessionInitials, useAccount } from './account.js';
import { Popover } from './Popover.js';
import { TOPBAR_PRIORITY } from './topbar/fit.js';
import { TopbarItem } from './topbar/TopbarItem.js';

function UserIcon(): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

/** The popover's body, its own chunk. */
const Account = lazy(() => import('./AccountContent.js'), { export: 'AccountContent' });

/**
 * The topbar's auth button (`#auth-button`) and the logged-in account's
 * popover (`#user-popover`, a Popover whose body, AccountContent, is its own
 * chunk; a bottom sheet on phones), an item of the topbar's action group
 * (see TopbarActions.tsx) that never collapses into More. The host page
 * renders it logged out at build time, and it shows the session once
 * hydrated. The landing page (components/landing/) renders it too, in its
 * corner.
 *
 * Logged out, the button shows the person icon and a click starts a login.
 * Logged in, it shows the account's initials (`.user-badge`, or the icon as
 * `.user-badge-anon` without a username). A click toggles the user popover
 * while the auth state is `Connected`, and starts a login, which opens the
 * auth modal, in any other state (a pairing started while logged in
 * included). Its trigger ARIA follows the click, like a Radix
 * Popover.Trigger or Dialog.Trigger: `aria-haspopup="dialog"`, with
 * `aria-controls` and `aria-expanded` for the user popover while
 * `Connected`, else for the auth modal (`#auth-modal-backdrop`, open as
 * authModalStore says).
 *
 * `idPrefix` sets another instance's ids apart (the landing page's, whose
 * page also holds the topbar's build-time markup).
 */
export function AuthButton(props: { idPrefix?: string }): JSX.Element {
  const id = (name: string): string => `${props.idPrefix ?? ''}${name}`;
  let button: HTMLButtonElement | undefined;
  const account = useAccount();
  const authModal = useStore(authModalStore);
  /**
   * A click toggles the user popover, else opens the auth modal (see
   * onClick), so the ARIA says so.
   */
  const opensPopover = account.connected;
  const label = (): string => (account.loggedIn() ? 'Account' : 'Login with Polkadot Mobile');
  // The auth modal's trigger, while mounted (see setAuthModalTrigger).
  onSettled(() => (button === undefined ? undefined : setAuthModalTrigger(button)));

  return (
    <Popover
      id={id('user-popover')}
      title="Welcome back"
      class="user-popover"
      content={Account}
      trigger={t => {
        const onClick = (ev?: Event): void => {
          if (getAuthState().tag === 'Connected') {
            t.onClick(ev);
          } else {
            startLogin();
          }
        };
        return (
          <TopbarItem name="auth" label={label()} icon={UserIcon} priority={TOPBAR_PRIORITY.auth} activate={onClick}>
            <button
              {...t}
              ref={el => {
                button = el;
                t.ref(el);
              }}
              onClick={onClick}
              id={id('auth-button')}
              class="topbar-btn"
              title={label()}
              aria-label={label()}
              aria-expanded={(opensPopover() ? t['aria-expanded'] === 'true' : authModal().open) ? 'true' : 'false'}
              aria-controls={opensPopover() ? t['aria-controls'] : 'auth-modal-backdrop'}
            >
              <Show when={account.loggedIn() && account.session()} fallback={<UserIcon />}>
                {session => (
                  <Show
                    when={sessionInitials(session())}
                    fallback={
                      <div class="user-badge user-badge-anon">
                        <UserIcon />
                      </div>
                    }
                  >
                    {initials => <div class="user-badge">{initials()}</div>}
                  </Show>
                )}
              </Show>
            </button>
          </TopbarItem>
        );
      }}
    />
  );
}
