// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, lazy, onSettled, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { startLogin } from '../../auth-controller.js';
import { getAuthState, sessionRestoredStore } from '../../state/auth.js';
import { authModalStore, setAuthModalTrigger } from '../../state/auth-modal.js';
import { Popover } from '../floating/Popover.js';
import { Button } from '../primitives/Button.js';
import { useStore } from '../use-store.js';
import { sessionDisplayName, sessionInitials, useAccount, UserIcon } from './account.js';
import { TOPBAR_PRIORITY } from './topbar/fit.js';
import { TopbarItem } from './topbar/TopbarItem.js';
import s from './AuthButton.module.css';

const Account = lazy(() => import('./AccountContent.js'), { export: 'AccountContent' });

/**
 * The auth button and the account popover, in the topbar and in the landing page's corner.
 *
 * A click toggles the popover only while `Connected`, and starts a login in any other state, a pairing
 * under way while logged in included. The trigger ARIA follows the click: the Popover writes it while
 * `Connected`, this component writes it for the auth modal otherwise.
 *
 * `idPrefix` keeps the landing page's ids apart from the topbar's build-time markup on the same page.
 */
export function AuthButton(props: { idPrefix?: string | undefined; showName?: boolean | undefined }): JSX.Element {
  const id = (name: string): string => `${props.idPrefix ?? ''}${name}`;
  const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  const account = useAccount();
  const authModal = useStore(authModalStore);
  const restored = useStore(sessionRestoredStore);
  const opensPopover = account.connected;
  const shownName = (): string | undefined => {
    const session = props.showName === true && account.loggedIn() ? account.session() : undefined;
    return session === undefined ? undefined : sessionDisplayName(session);
  };
  const label = (): string => (account.loggedIn() ? 'Account' : 'Sign in with Polkadot Mobile');
  // The visible text starts the accessible name, so speech input can use it.
  const ariaLabel = (): string => {
    const session = account.loggedIn() ? account.session() : undefined;
    const initials = session === undefined ? undefined : sessionInitials(session);
    const visible = [initials, shownName()].filter(part => part !== undefined).join(' ');
    return visible === '' ? label() : `${visible}, account`;
  };
  onSettled(() => {
    const el = untrack(button);
    return el === undefined ? undefined : setAuthModalTrigger(el);
  });
  // While connected the Popover's own trigger listener takes the click.
  const onClick = (): void => {
    if (getAuthState().tag !== 'Connected') {
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
          loading={!restored()}
          title={label()}
          aria-label={ariaLabel()}
          aria-haspopup={opensPopover() ? undefined : 'dialog'}
          aria-expanded={opensPopover() ? undefined : authModal().open ? 'true' : 'false'}
          aria-controls={opensPopover() ? undefined : 'auth-modal-backdrop'}
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
