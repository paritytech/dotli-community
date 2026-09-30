// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { onSettled, Show } from 'solid-js';
import { Portal, type JSX } from '@solidjs/web';
import { requestTruapiDisconnect, startLogin } from '../../auth-controller.js';
import { getAuthState } from '../../state/auth.js';
import { authModalStore, setAuthModalTrigger } from '../../state/auth-modal.js';
import { useStore } from '../use-store.js';
import { sessionInitials, sessionUsername, shortenAccount, useAccount } from './account.js';
import { createPopover } from './popover.js';
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

/**
 * The topbar's auth button (`#auth-button`) and the logged-in account's
 * popover (`#user-popover`, rendered into the body), an item of the topbar's
 * action group (see TopbarActionsIsland.tsx) that never collapses into
 * More. The host page renders it logged out at build time, and it shows the
 * session once hydrated. The landing page (components/landing/) renders it
 * too, in its corner.
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
 * authModalStore says). It renders the auth stores, whatever they held when
 * it mounted.
 *
 * The popover shows the username (or the shortened account, with a hint
 * that the account has no username on this network) and Log out, which asks
 * the Rust core to disconnect. A press outside, focus leaving it, Escape and
 * a blocking modal close it, a non-modal popover (createPopover's `popover`
 * mode, `role="dialog"` named after its "Welcome back" heading) that hands
 * focus back to the button unless the user moved it.
 */
export function AuthButton(): JSX.Element {
  let button: HTMLButtonElement | undefined;
  let popover: HTMLDivElement | undefined;
  const account = useAccount();
  const authModal = useStore(authModalStore);
  const menu = createPopover({
    mode: 'popover',
    trigger: () => button,
    surface: () => popover,
  });
  /**
   * A click toggles the user popover, else opens the auth modal (see
   * onClick), so the ARIA says so.
   */
  const opensPopover = account.connected;
  const label = (): string => (account.loggedIn() ? 'Account' : 'Login with Polkadot Mobile');
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

  const onClick = (): void => {
    if (getAuthState().tag === 'Connected') {
      menu.toggle();
    } else {
      startLogin();
    }
  };
  // The auth modal's trigger, while mounted (see setAuthModalTrigger).
  onSettled(() => (button === undefined ? undefined : setAuthModalTrigger(button)));
  const onDisconnect = (): void => {
    menu.setOpen(false);
    requestTruapiDisconnect();
  };

  return (
    <>
      <TopbarItem name="auth" label={label()} icon={UserIcon} priority={TOPBAR_PRIORITY.auth} activate={onClick}>
        <button
          ref={el => {
            button = el;
          }}
          onClick={onClick}
          id="auth-button"
          class="topbar-btn"
          title={label()}
          aria-label={label()}
          aria-haspopup="dialog"
          aria-expanded={(opensPopover() ? menu.open() : authModal().open) ? 'true' : 'false'}
          aria-controls={opensPopover() ? 'user-popover' : 'auth-modal-backdrop'}
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
      <Portal>
        <div
          ref={el => {
            popover = el;
          }}
          class={['user-popover', { open: menu.open() }]}
          id="user-popover"
          role="dialog"
          aria-label="Welcome back"
          tabindex="-1"
        >
          <div class="user-popover-name">
            <div class="label">Welcome back</div>
            <div class="name" id="user-popover-username">
              {name()}
            </div>
            {/* Explains the username-less state instead of leaving a bare
                address that reads as a rendering bug. */}
            <Show when={account.loggedIn() && (username() ?? '').length === 0}>
              <div id="user-popover-hint" class="user-popover-hint">
                No username found for this account on this network.
              </div>
            </Show>
          </div>
          <div class="user-popover-divider" />
          <button onClick={onDisconnect} class="user-popover-disconnect" id="user-popover-disconnect">
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
        </div>
      </Portal>
    </>
  );
}
