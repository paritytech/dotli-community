// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { lazy, onSettled, Show } from 'solid-js';
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
 * user popover while `Connected`, else for the auth modal
 * (`#auth-modal-backdrop`, open as authModalStore says).
 *
 * `idPrefix` sets another instance's ids apart (the landing page's, whose
 * page also holds the topbar's build-time markup).
 */
export function AuthButton(props: { idPrefix?: string | undefined; showName?: boolean | undefined }): JSX.Element {
  const id = (name: string): string => `${props.idPrefix ?? ''}${name}`;
  let button: HTMLButtonElement | undefined;
  const account = useAccount();
  const authModal = useStore(authModalStore);
  /**
   * A click toggles the user popover, else opens the auth modal (see
   * onClick), so the ARIA says so.
   */
  const opensPopover = account.connected;
  /** The name beside the avatar, with `showName`: the username, else the shortened account. */
  const shownName = (): string | undefined => {
    const session = props.showName === true && account.loggedIn() ? account.session() : undefined;
    return session === undefined ? undefined : sessionDisplayName(session);
  };
  const label = (): string => (account.loggedIn() ? 'Account' : 'Sign in with Polkadot Mobile');
  // A visible name starts the button's name, so speech input can use it.
  const ariaLabel = (): string => {
    const name = shownName();
    return name === undefined ? label() : `${name}, account`;
  };
  // The auth modal's trigger, while mounted (see setAuthModalTrigger).
  onSettled(() => (button === undefined ? undefined : setAuthModalTrigger(button)));

  return (
    <Popover id={id('user-popover')} title="Account">
      <Popover.Trigger>
        {(t, activate) => {
          // While connected the click is the popover's (the trigger's own
          // listener); otherwise it starts the login.
          const onClick = (): void => {
            if (getAuthState().tag !== 'Connected') {
              startLogin();
            }
          };
          const activateItem = (ev?: Event): void => {
            if (getAuthState().tag === 'Connected') {
              activate(ev);
            } else {
              startLogin();
            }
          };
          return (
            <TopbarItem
              name="auth"
              label={label()}
              icon={UserIcon}
              priority={TOPBAR_PRIORITY.auth}
              activate={activateItem}
              separated
            >
              {/* One element across login and logout, so the auth modal keeps its trigger. */}
              <Button
                ref={el => {
                  button = el;
                  t.ref(el);
                }}
                onClick={onClick}
                id={id('auth-button')}
                popovertarget={opensPopover() ? t.popovertarget : undefined}
                style={t.style}
                title={label()}
                aria-label={ariaLabel()}
                aria-haspopup={opensPopover() ? t['aria-haspopup'] : 'dialog'}
                aria-expanded={(opensPopover() ? t['aria-expanded'] === 'true' : authModal().open) ? 'true' : 'false'}
                aria-controls={opensPopover() ? t['aria-controls'] : 'auth-modal-backdrop'}
                variant={account.loggedIn() ? 'secondary' : 'primary'}
                class={
                  account.loggedIn()
                    ? [s['chip'], shownName() === undefined ? s['avatarOnly'] : undefined].join(' ').trim()
                    : s['signIn']
                }
              >
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
              </Button>
            </TopbarItem>
          );
        }}
      </Popover.Trigger>
      <Popover.Content class={s['popover']} preload={Account.preload}>
        <Account />
      </Popover.Content>
    </Popover>
  );
}
