// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, createSignal, lazy, onSettled, Show, untrack, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { ActionItem, Button, Popover } from '@dotli/ui';
import { AlertTriangleIcon } from '@dotli/ui/icons';
import { TOPBAR_PRIORITY } from '../topbar/priority.js';
import { AccountAvatar } from './AccountAvatar.js';
import { sessionDisplayName, sessionInitials } from './accountNames.js';
import { UserIcon } from '../icons/UserIcon.js';
import { getAuthButtonState } from './account.js';
import type { Account, AccountSession, AuthButtonFace, AuthButtonState } from './account.js';
import s from './AuthButton.module.css';
import { loadAccountContent } from '../../lazy.js';

const AccountPanel = lazy(loadAccountContent, { export: 'AccountContent' });

export type AuthButtonProps = {
  account: Account;
  /** Whether the auth modal is open, which the button announces while a click starts a sign-in. */
  modalOpen: Accessor<boolean>;
  /** A click while not `Connected`. */
  onSignIn: () => void;
  /** Sign out in the account popover. */
  onLogout: () => void;
  /** Hands the button to the auth modal, which gives it focus back as it closes. Returns the hand back. */
  handOver?: ((button: HTMLElement) => () => void) | undefined;
  /** Keeps the landing page's ids apart from the topbar's build-time markup on the same page. */
  idPrefix?: string | undefined;
  /** Shows the name beside the initials, as the landing page does. */
  showName?: boolean | undefined;
  /** The signed-in sites page, which the account popover links to in a new tab. */
  sitesUrl?: string | undefined;
  /** Gets the button once it is on the page. */
  buttonRef?: ((button: HTMLButtonElement) => void) | undefined;
};

/** A signed-in account by where its keys live, in this browser or in Polkadot App. */
function getAccountKind(local: boolean): string {
  return local ? 'Local account' : 'Account';
}

/** What a button that resumes says it does. The page only knows a sign-in exists, so it names no account. */
const RESUME_TITLE = 'Continue the sign-in you already made to keep using this app';

/** What the button says it does in `state`: its title, and its More row's label. */
function getAuthLabel(state: AuthButtonState, local: boolean): string {
  switch (state.kind) {
    case 'checking':
      return 'Checking sign-in';
    case 'unreachable':
      return "Can't reach your sign-in";
    case 'signingOut':
      return 'Signing out';
    case 'resume':
      return 'Continue session';
    case 'signIn':
      return 'Sign in with Polkadot App';
    case 'signedIn':
      return getAccountKind(local);
  }
}

/** Whether the button shows its loading state and takes no clicks. */
function isBusy(state: AuthButtonState): boolean {
  switch (state.kind) {
    case 'checking':
    case 'signingOut':
      return true;
    case 'unreachable':
      return state.busy;
    case 'resume':
    case 'signIn':
    case 'signedIn':
      return false;
  }
}

/** The button's title. The name stays the visible text, and a button that resumes describes the sign-in it continues. */
function getAuthTitle(state: AuthButtonState, label: string): string {
  switch (state.kind) {
    case 'resume':
      return RESUME_TITLE;
    case 'checking':
    case 'unreachable':
    case 'signingOut':
    case 'signIn':
    case 'signedIn':
      return label;
  }
}

type ButtonAppearance = {
  variant: 'primary' | 'secondary';
  class: string;
};

/** How a face looks: the button's variant and class, and what the button shows. */
type FaceLook = ButtonAppearance & {
  /** The session the face shows as its avatar, or undefined when it shows an icon. */
  avatar: AccountSession | undefined;
  /** The name beside the avatar, on a page that shows names. */
  name: string | undefined;
  /** Whether the alert icon stands in place of the user icon and the prompt's text. */
  alert: boolean;
  /** The prompt's text beside the user icon. */
  text: string;
  /** Whether the prompt continues a sign-in made elsewhere, which `data-session` says. */
  resumes: boolean;
};

/** An icon chip: the button shows an icon, not an avatar. */
const ICON_CHIP_LOOK: FaceLook = {
  variant: 'secondary',
  class: [s['chip'], s['avatarOnly']].join(' '),
  avatar: undefined,
  name: undefined,
  alert: false,
  text: 'Sign in',
  resumes: false,
};

/** The look of `face`: a chip for the account and the alert, else the sign-in pill. */
function getFaceLook(face: AuthButtonFace, showName: boolean): FaceLook {
  switch (face.kind) {
    case 'account':
      return getAccountLook(face.session, showName);
    case 'prompt':
      return {
        variant: 'primary',
        class: s['signIn'] ?? '',
        avatar: undefined,
        name: undefined,
        alert: false,
        text: face.resumes ? 'Continue session' : 'Sign in',
        resumes: face.resumes,
      };
    case 'alert':
      return { ...ICON_CHIP_LOOK, alert: true };
  }
}

/** The account's chip: its avatar and, on a page that shows names, its name. With no session to show, an icon chip. */
function getAccountLook(session: AccountSession | undefined, showName: boolean): FaceLook {
  if (session === undefined) {
    return ICON_CHIP_LOOK;
  }
  const name = showName ? sessionDisplayName(session) : undefined;
  return {
    variant: 'secondary',
    class: [s['chip'], name === undefined ? s['avatarOnly'] : undefined].join(' ').trim(),
    avatar: session,
    name,
    alert: false,
    text: 'Sign in',
    resumes: false,
  };
}

/**
 * The auth button and the account popover, in the topbar and in the landing page's corner.
 *
 * A click toggles the popover only while `Connected`, and starts a sign-in in any other state, a pairing under way
 * while logged in included. It takes no clicks while the saved session is being read, and shows an alert icon button
 * that reads it again while it cannot be reached. The trigger ARIA follows the click: the Popover writes it while
 * `Connected`, this component writes it for the auth modal otherwise. Signed out while a sign-in made elsewhere waits, it reads Continue session.
 */
export function AuthButton(props: AuthButtonProps): JSX.Element {
  const id = (name: string): string => `${props.idPrefix ?? ''}${name}`;
  const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  const account = (): Account => props.account;
  const opensPopover = (): boolean => account().connected();
  const state = createMemo(() => getAuthButtonState(account()));
  const look = createMemo(() => getFaceLook(state().face, props.showName === true));
  const label = (): string => getAuthLabel(state(), account().local());
  // The visible text starts the accessible name, so speech input can use it.
  const ariaLabel = (): string => {
    const avatar = look().avatar;
    const initials = avatar === undefined ? undefined : sessionInitials(avatar);
    const visible = [initials, look().name].filter(part => part !== undefined).join(' ');
    return visible === '' ? label() : `${visible}, ${getAccountKind(account().local()).toLowerCase()}`;
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
        testId={id('auth-button')}
        loading={isBusy(state())}
        title={getAuthTitle(state(), label())}
        aria-label={ariaLabel()}
        aria-haspopup={opensPopover() ? undefined : 'dialog'}
        aria-expanded={opensPopover() ? undefined : props.modalOpen() ? 'true' : 'false'}
        aria-controls={opensPopover() ? undefined : 'auth-modal-backdrop'}
        variant={look().variant}
        class={look().class}
      >
        <Show
          when={look().avatar}
          fallback={
            <Show when={!look().alert} fallback={<AlertTriangleIcon class={s['signInIcon']} />}>
              <UserIcon class={s['signInIcon']} />
              <span
                class={s['label']}
                data-testid="auth-button-label"
                data-session={look().resumes ? 'elsewhere' : undefined}
              >
                {look().text}
              </span>
            </Show>
          }
        >
          {session => (
            <>
              <AccountAvatar session={session()} size="sm" local={account().local()} testId="user-badge" />
              <Show when={look().name}>
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
        <AccountPanel account={props.account} onLogout={props.onLogout} sitesUrl={props.sitesUrl} />
      </Popover>
    </>
  );
}

/** The account button in a bar: never collapses, and ends the bar after a hairline. Outside a bar it stands alone. */
export function AccountItem(props: AuthButtonProps): JSX.Element {
  // Read only on a More row's click, so it needs no signal.
  let button: HTMLButtonElement | undefined;
  return (
    <ActionItem
      name="auth"
      label={getAuthLabel(getAuthButtonState(props.account), props.account.local())}
      icon={UserIcon}
      priority={TOPBAR_PRIORITY.auth}
      activate={() => {
        button?.click();
      }}
      separated
    >
      <AuthButton
        {...props}
        buttonRef={el => {
          button = el;
        }}
      />
    </ActionItem>
  );
}
