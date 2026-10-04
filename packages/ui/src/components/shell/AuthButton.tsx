// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { lazy, onSettled, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { startLogin } from '../../auth-controller.js';
import { getAuthState } from '../../state/auth.js';
import { authModalStore, setAuthModalTrigger } from '../../state/auth-modal.js';
import { Button } from '../primitives/Button.js';
import { IconButton } from '../primitives/IconButton.js';
import { useStore } from '../use-store.js';
import { sessionInitials, sessionUsername, shortenAccount, useAccount } from './account.js';
import { Popover } from './Popover.js';
import { TOPBAR_PRIORITY } from './topbar/fit.js';
import { TopbarItem } from './topbar/TopbarItem.js';
import s from './AuthButton.module.css';

function UserIcon(props: { size?: number } = {}): JSX.Element {
  return (
    <svg
      width={props.size ?? 12}
      height={props.size ?? 12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
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
 * Logged in, it shows the account's initials in its badge, or the icon there
 * (`data-anon`) without a username. A click toggles the user popover
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
export function AuthButton(props: {
  idPrefix?: string | undefined;
  variant?: 'icon' | 'chip' | undefined;
}): JSX.Element {
  const id = (name: string): string => `${props.idPrefix ?? ''}${name}`;
  let button: HTMLButtonElement | undefined;
  const account = useAccount();
  const authModal = useStore(authModalStore);
  /**
   * A click toggles the user popover, else opens the auth modal (see
   * onClick), so the ARIA says so.
   */
  const opensPopover = account.connected;
  /** The bar's look: a Sign in button, then an avatar and name chip. */
  const chip = (): boolean => props.variant === 'chip';
  /** The name the chip shows: the username, else the shortened account. */
  const chipName = (): string | undefined => {
    const session = account.loggedIn() ? account.session() : undefined;
    return session === undefined
      ? undefined
      : (sessionUsername(session) ?? shortenAccount(session.identityAccountId ?? session.publicKey));
  };
  // The visible name starts the button's name, so speech input can use it.
  const chipLabel = (): string => {
    const name = chipName();
    return name === undefined ? label() : `${name}, account`;
  };
  const label = (): string => (account.loggedIn() ? 'Account' : 'Sign in with Polkadot Mobile');
  // The auth modal's trigger, while mounted (see setAuthModalTrigger).
  onSettled(() => (button === undefined ? undefined : setAuthModalTrigger(button)));

  return (
    <Popover
      id={id('user-popover')}
      title="Account"
      class={s['popover']}
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
            <Show
              when={chip()}
              fallback={
                <IconButton
                  {...t}
                  ref={el => {
                    button = el;
                    t.ref(el);
                  }}
                  onClick={onClick}
                  id={id('auth-button')}
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
                          <div class={s['badge']} data-testid="user-badge" data-anon="">
                            <UserIcon />
                          </div>
                        }
                      >
                        {initials => (
                          <div class={s['badge']} data-testid="user-badge">
                            {initials()}
                          </div>
                        )}
                      </Show>
                    )}
                  </Show>
                </IconButton>
              }
            >
              {/* One element across login and logout, so the auth modal keeps its trigger. */}
              <Button
                ref={el => {
                  button = el;
                  t.ref(el);
                }}
                onClick={onClick}
                id={id('auth-button')}
                title={label()}
                aria-label={chipLabel()}
                aria-haspopup={t['aria-haspopup']}
                aria-expanded={(opensPopover() ? t['aria-expanded'] === 'true' : authModal().open) ? 'true' : 'false'}
                aria-controls={opensPopover() ? t['aria-controls'] : 'auth-modal-backdrop'}
                variant={account.loggedIn() ? 'secondary' : 'primary'}
                class={account.loggedIn() ? s['chip'] : s['signIn']}
              >
                <Show
                  when={account.loggedIn() && account.session()}
                  fallback={
                    <>
                      <UserIcon size={16} />
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
                        <Show when={sessionInitials(session())} fallback={<UserIcon size={16} />}>
                          {initials => <>{initials()}</>}
                        </Show>
                      </span>
                      <span class={s['name']}>{chipName() ?? 'Account'}</span>
                    </>
                  )}
                </Show>
              </Button>
            </Show>
          </TopbarItem>
        );
      }}
    />
  );
}
