// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor } from 'storybook/test';
import { byId, byTestId } from '@dotli/ui/testing';
import { expectPhone, openSurface, TopbarFrame } from '../../testing/stories/topbar-frame.js';
import {
  calls,
  connect,
  disconnect,
  localWallet,
  notConnected,
  resetStoryAccount,
  setModalOpen,
  signedInElsewhere,
  signingOut,
  storyAccount,
  storyCallbacks,
  storyModalOpen,
  unreachable,
} from '../../testing/stories/account-fixtures.js';
import type { AccountSession } from './account.js';
import { AuthButton } from './AuthButton.js';

const open = openSurface({ trigger: 'auth-button', surface: 'user-popover' });

const PUBLIC_KEY = '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const ALICE: AccountSession = { fullUsername: 'Alice Smith' };
const PG: AccountSession = { liteUsername: 'pgherveou.04' };

const button = (): HTMLElement => byId('auth-button');
const signInLabel = (): HTMLElement => byTestId('auth-button-label', button());
const badge = (): HTMLElement => byTestId('user-badge', button());
const isOpen = (): boolean => document.getElementById('user-popover')?.hasAttribute('data-open') === true;
const popupAria = (): (string | null)[] =>
  ['aria-haspopup', 'aria-expanded', 'aria-controls'].map(name => button().getAttribute(name));

/** The button as the page binds it, to the story's account and sign-in. */
function StoryButton(props: { idPrefix?: string; showName?: boolean; sitesUrl?: string }): JSX.Element {
  return (
    <AuthButton
      account={storyAccount}
      modalOpen={storyModalOpen}
      onSignIn={storyCallbacks.onSignIn}
      onLogout={storyCallbacks.onLogout}
      handOver={storyCallbacks.handOver}
      idPrefix={props.idPrefix}
      showName={props.showName}
      sitesUrl={props.sitesUrl}
    />
  );
}

/** Everything the button carries apart from styling, logged out or logged in. */
async function expectButton(state: 'logged-out' | { initials: string | undefined }): Promise<void> {
  const b = button();
  const label = state === 'logged-out' ? 'Sign in with Polkadot App' : 'Account';
  await expect(b).toHaveAttribute('title', label);
  await expect(b).toHaveAttribute(
    'aria-label',
    state !== 'logged-out' && state.initials !== undefined ? `${state.initials}, account` : label,
  );
  await expect(b).not.toHaveAttribute('disabled');
  await expect(b).not.toHaveAttribute('aria-busy');
  if (state === 'logged-out') {
    await expect(popupAria()).toEqual(['dialog', storyModalOpen() ? 'true' : 'false', 'auth-modal-backdrop']);
    await expect(b.textContent.trim()).toBe('Sign in');
    await expect(signInLabel()).not.toHaveAttribute('data-session');
    return;
  }
  await expect(b).toHaveAttribute('aria-controls', 'user-popover');
  if (state.initials !== undefined) {
    await expect(badge().textContent).toBe(state.initials);
  } else {
    await expect(badge().textContent).toBe('');
  }
}

/** The open account popover's name line and hint. */
async function expectAccount(username: string, hint: boolean): Promise<void> {
  await expect(byId('user-popover-username').textContent).toBe(username);
  if (hint) {
    await expect(byId('user-popover-hint').textContent).toBe('No username found for this account on this network.');
  } else {
    await expect(document.getElementById('user-popover-hint')).toBeNull();
  }
}

const meta = {
  title: 'Host/Account/AuthButton',
  component: StoryButton,
  parameters: { chrome: true, docs: { story: { inline: false, height: '360px' } } },
  // Boot has not read the saved session yet until a story says otherwise.
  beforeEach: resetStoryAccount,
  render: () => (
    <TopbarFrame>
      <StoryButton />
    </TopbarFrame>
  ),
} satisfies Meta<typeof StoryButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * As a logged-in user, the popover shows my name with no hint, as a dialog named Account, and no local account
 * mark, since my keys are in Polkadot App.
 */
export const Open: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    connect(ALICE);
  },
  play: async ctx => {
    await ctx.step('Given my badge carries no local account mark', async () => {
      await expect(badge()).not.toHaveAttribute('data-wallet');
      await expect(button()).toHaveAttribute('title', 'Account');
    });
    await open(ctx);
    await ctx.step('Then it is a dialog named Account with my name and avatar', async () => {
      const popover = byId('user-popover');
      await expect(popover).toHaveAttribute('role', 'dialog');
      await expect(popover).toHaveAttribute('aria-label', 'Account');
      await expect(popover).toHaveAttribute('tabindex', '-1');
      await expectAccount('Alice Smith', false);
      await expect(popover.querySelector('[data-testid="account-content"]')).toHaveTextContent(/^ASWelcome back/);
      await expect(byId('user-popover-disconnect')).toHaveTextContent('Sign out');
      await expect(document.querySelector('[data-testid="account-local"]')).toBeNull();
    });
  },
};

/** As a signed-in user, the popover links to my signed-in sites and opens them in a new tab. */
export const SitesLink: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    connect(ALICE);
  },
  render: () => (
    <TopbarFrame>
      <StoryButton sitesUrl="https://dot.li/s/manage" />
    </TopbarFrame>
  ),
  play: async ctx => {
    await open(ctx);
    await ctx.step('Then the menu links to the signed-in sites in a new tab', async () => {
      const link = byTestId('account-sites', byId('user-popover'));
      await expect(link).toHaveTextContent('Signed-in sites');
      await expect(link).toHaveAttribute('href', 'https://dot.li/s/manage');
      await expect(link).toHaveAttribute('target', '_blank');
    });
  },
};

/** As a signed-in user where no sites page is given, the popover shows no sites link. */
export const NoSitesLink: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    connect(ALICE);
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('Then the menu has no signed-in sites link', async () => {
      await expectAccount('Alice Smith', false);
      await expect(document.querySelector('[data-testid="account-sites"]')).toBeNull();
    });
  },
};

/** As a signed-out user where a sites page is given, I see no sites link, and a click starts a sign-in. */
export const SignedOutNoSitesLink: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    disconnect();
  },
  render: () => (
    <TopbarFrame>
      <StoryButton sitesUrl="https://dot.li/s/manage" />
    </TopbarFrame>
  ),
  play: async ({ step, userEvent }) => {
    await step('When I click the button', async () => {
      await userEvent.click(button());
    });
    await step('Then a sign-in was asked for, and the page has no signed-in sites link', async () => {
      await waitFor(() => expect(calls.signIns).toBe(1));
      await expect(document.querySelector('[data-testid="account-sites"]')).toBeNull();
    });
  },
};

/** As a phone user, my account opens as a sheet titled Account, its body without a heading of its own. */
export const OpenPhone: Story = {
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  beforeEach: () => {
    connect(PG);
  },
  play: async ctx => {
    await expectPhone(ctx.step);
    await open(ctx);
    await ctx.step('Then the sheet is titled Account and the body has no heading', async () => {
      const sheet = byId('user-popover');
      await expect(sheet.querySelector('[data-testid="popover-sheet-title"]')).toHaveTextContent('Account');
      const content = sheet.querySelector('[data-testid="account-content"]');
      await expect(content).toHaveAttribute('data-sheet');
      await expect(content?.querySelector('h2')).toBeNull();
    });
  },
};

/** As a signed-in local wallet user, my badge and my account are marked as a local account. */
export const LocalWallet: Story = {
  beforeEach: () => {
    localWallet();
    connect(ALICE);
  },
  play: async ctx => {
    await ctx.step('Then the badge is marked local', async () => {
      await expect(badge()).toHaveAttribute('data-wallet', 'local');
      await expect(button()).toHaveAttribute('title', 'Local account');
      await expect(button()).toHaveAttribute('aria-label', 'AS, local account');
    });
    await open(ctx);
    await ctx.step('And the account says Local account', async () => {
      await expect(document.querySelector('[data-testid="account-local"]')).toHaveTextContent('Local account');
    });
  },
};

/** As a logged-out user in the bar, I see an enabled Sign in button named for Polkadot App. */
export const LoggedOut: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    disconnect();
  },
  play: async ({ step }) => {
    await step('Then the button reads Sign in and announces the auth modal', async () => {
      await expect(button().querySelector('[data-testid="user-badge"]')).toBeNull();
      await expectButton('logged-out');
    });
  },
};

/**
 * As a signed-out user whose sign-in made in another app waits, I see the button offer to continue it without naming an
 * account and say what it continues, and a click starts a sign-in. It reads Sign in again once nothing waits.
 */
export const ContinueSession: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    disconnect();
    signedInElsewhere();
  },
  play: async ({ userEvent, step }) => {
    await step('Then the button reads Continue session and describes the sign-in it continues', async () => {
      await expect(signInLabel()).toHaveAttribute('data-session', 'elsewhere');
      await expect(button().textContent.trim()).toBe('Continue session');
      await expect(button()).toHaveAttribute('aria-label', 'Continue session');
      await expect(button()).toHaveAttribute('title', 'Continue the sign-in you already made to keep using this app');
      await expect(popupAria()).toEqual(['dialog', 'false', 'auth-modal-backdrop']);
    });
    await step('When I click it', async () => {
      await userEvent.click(button());
    });
    await step('Then one sign-in was asked for', async () => {
      await waitFor(() => expect(calls.signIns).toBe(1));
    });
    await step('When the sign-in elsewhere is signed out, as a recheck of the flag finds', () => {
      setModalOpen(false);
      signedInElsewhere(false);
    });
    await step('Then the button reads Sign in again', async () => {
      await waitFor(() => expect(signInLabel()).not.toHaveAttribute('data-session'));
      await expectButton('logged-out');
    });
  },
};

/** As a signed-in user in the bar, I see my initials alone, not my name. */
export const InitialsNotName: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    connect(ALICE);
  },
  play: async ({ step }) => {
    await step('Then the badge shows AS and the button never shows my name', async () => {
      await expect(badge().textContent).toBe('AS');
      await expect(button().textContent).not.toContain('Alice Smith');
      await expectButton({ initials: 'AS' });
    });
  },
};

/** As a logged-in user with a username, I see its initials in the badge. */
export const UsernameInitials: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    connect({ publicKey: PUBLIC_KEY, liteUsername: 'pgherveou.04', primaryUsername: 'pgherveou.04' });
  },
  play: async ({ step }) => {
    await step('Then the badge shows PG', async () => {
      await expect(button().textContent).toBe('PG');
      await expectButton({ initials: 'PG' });
    });
  },
};

/** As a signed-in user whose name changes, the badge in the bar and my open account follow the new initials. */
export const NameChangeFollows: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    connect({ ...ALICE, publicKey: PUBLIC_KEY });
  },
  play: async ctx => {
    await open(ctx);
    const avatar = (): HTMLElement => byTestId('account-avatar');
    await ctx.step('Given AS in the badge and the account', async () => {
      await expect(badge().textContent).toBe('AS');
      await expect(avatar().textContent).toBe('AS');
    });
    await ctx.step('When my name changes', () => {
      connect({ publicKey: PUBLIC_KEY, fullUsername: 'Bob Jones' });
    });
    await ctx.step('Then both show BJ', async () => {
      await waitFor(() => expect(badge().textContent).toBe('BJ'));
      await expect(avatar().textContent).toBe('BJ');
    });
  },
};

/** As a signed-in user on the landing page, I see my initials and my name, which also start the button's name. */
export const Landing: Story = {
  beforeEach: () => {
    connect(ALICE);
  },
  render: () => <StoryButton idPrefix="landing-" showName />,
  play: async ({ step }) => {
    await step('Then the button shows AS and Alice Smith, and its name starts with both', async () => {
      const landing = byId('landing-auth-button');
      await expect(landing.querySelector('[data-testid="user-badge"]')?.textContent).toBe('AS');
      await expect(landing.textContent).toContain('Alice Smith');
      await expect(landing).toHaveAttribute('aria-label', 'AS Alice Smith, account');
    });
  },
};

/** As a visitor whose session is still being read, I see a busy button that takes no clicks, then Sign in. */
export const Checking: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('Then the button is busy, disabled and named for the check', async () => {
      await expect(button()).toBeDisabled();
      await expect(button()).toHaveAttribute('aria-busy', 'true');
      await expect(button().textContent.trim()).toBe('');
      await expect(button()).toHaveAttribute('aria-label', 'Checking sign-in');
      await expect(button()).toHaveAttribute('title', 'Checking sign-in');
    });
    await step('When the read finds no saved session', () => {
      disconnect();
    });
    await step('Then it is the Sign in button', async () => {
      await waitFor(() => expect(button()).not.toBeDisabled());
      await expectButton('logged-out');
    });
  },
};

/** As a returning user, the busy button turns into my badge without showing Sign in first. */
export const ReturningBecomesBadge: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      seen.push(button().textContent);
    });
    await step('Given the busy button while the session is read', async () => {
      await expect(button()).toHaveAttribute('aria-busy', 'true');
      observer.observe(button(), { childList: true, subtree: true, characterData: true });
    });
    await step('When the read finds my session', () => {
      connect(ALICE);
    });
    await step('Then it shows my badge and never showed Sign in', async () => {
      await waitFor(() => expect(button().querySelector('[data-testid="user-badge"]')).not.toBeNull());
      observer.disconnect();
      await expectButton({ initials: 'AS' });
      await expect(seen.some(text => text.includes('Sign in'))).toBe(false);
    });
  },
};

/**
 * As a logged-in user without a username, I see the anonymous badge, and my account shows my shortened address and
 * explains why, until I reconnect with a username.
 */
export const Anonymous: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    connect({ publicKey: PUBLIC_KEY });
  },
  play: async ctx => {
    await ctx.step('Then the badge is the anonymous icon', async () => {
      await expect(badge()).toHaveAttribute('data-anon');
      await expectButton({ initials: undefined });
    });
    await open(ctx);
    await ctx.step('And the account shows the shortened address with the hint', async () => {
      await expectAccount('0x000102...1e1f', true);
    });
    await ctx.step('When I reconnect with a username', () => {
      connect(PG);
    });
    await ctx.step('Then the username shows and the hint is gone', async () => {
      await waitFor(() => expect(byId('user-popover-username').textContent).toBe('pgherveou.04'));
      await expectAccount('pgherveou.04', false);
    });
  },
};

/** As a logged-in user whose name contains markup, my badge and my account show it as text. */
export const MarkupName: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    connect({ fullUsername: '<b>x</b>', primaryUsername: '<b>x</b>' });
  },
  play: async ctx => {
    await ctx.step('Then the badge shows the initials as text', async () => {
      await expect(button().querySelector('b')).toBeNull();
      await expectButton({ initials: '<B' });
    });
    await open(ctx);
    await ctx.step('And the account shows the username as text', async () => {
      await expect(byId('user-popover').querySelector('b')).toBeNull();
      await expect(byId('user-popover-username').textContent).toBe('<b>x</b>');
    });
  },
};

/** As a user restored from a bare session, my account says I am connected with Polkadot App. */
export const BareSession: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    connect({});
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('Then it says Connected with Polkadot App, with the hint', async () => {
      await expectAccount('Connected with Polkadot App', true);
    });
  },
};

/** As a local wallet user restored from a bare session, my account says I am connected, not through Polkadot App. */
export const LocalBareSession: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    localWallet();
    connect({});
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('Then it says Connected', async () => {
      await expect(byId('user-popover-username').textContent).toBe('Connected');
    });
  },
};

/** As a user who logs out elsewhere, my account leaves no hint behind. */
export const LoggedOutNoHint: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    connect({ publicKey: PUBLIC_KEY });
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('Given the hint for an account with no username', async () => {
      await expect(byId('user-popover-hint')).toBeInTheDocument();
    });
    await ctx.step('When I am logged out', () => {
      disconnect();
    });
    await ctx.step('Then the hint is gone', async () => {
      await waitFor(() => expect(document.getElementById('user-popover-hint')).toBeNull());
    });
  },
};

/** As a logged-in user, Sign out requests a disconnect and closes the popover. */
export const SignOutClosesPopover: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    connect(PG);
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('When I press Sign out', async () => {
      await ctx.userEvent.click(byId('user-popover-disconnect'));
    });
    await ctx.step('Then one logout was asked for, no login, and the popover closed', async () => {
      await waitFor(() => expect(calls.logouts).toBe(1));
      await waitFor(() => expect(isOpen()).toBe(false));
      await expect(calls.signIns).toBe(0);
    });
  },
};

/** As a signed-in user whose session drops while my account is open, it closes and focus goes back to the button. */
export const SessionDropReturnsFocus: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    connect(PG);
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('Given focus on Sign out', () => {
      byId('user-popover-disconnect').focus();
    });
    await ctx.step('When the session drops', () => {
      disconnect();
    });
    await ctx.step('Then the account closed and the button has focus, announcing the auth modal', async () => {
      await waitFor(() => expect(isOpen()).toBe(false));
      await waitFor(() => expect(button()).toHaveFocus());
      await expect(button()).toHaveAttribute('aria-expanded', 'false');
      await expect(button()).toHaveAttribute('aria-controls', 'auth-modal-backdrop');
    });
  },
};

/** As a logged-in user, a pairing that starts elsewhere keeps my badge, and a disconnect brings the login button back. */
export const PairingKeepsBadge: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    connect(PG);
  },
  play: async ({ step }) => {
    await step('When a pairing starts', () => {
      notConnected();
    });
    await step('Then the badge stays, since only Connected and Disconnected change the button', async () => {
      await waitFor(() => expect(button()).toHaveAttribute('aria-controls', 'auth-modal-backdrop'));
      await expect(button().textContent).toBe('PG');
    });
    await step('When the session is disconnected', () => {
      disconnect();
    });
    await step('Then the login button is back', async () => {
      await waitFor(() => expect(button().textContent.trim()).toBe('Sign in'));
      await expectButton('logged-out');
    });
  },
};

/** As a logged-out user, clicking the button requests a login and opens the pairing modal, which the button announces. */
export const SignInOpensPairing: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    disconnect();
  },
  play: async ({ userEvent, step }) => {
    await step('Given the button announces the closed auth modal', async () => {
      await expect(popupAria()).toEqual(['dialog', 'false', 'auth-modal-backdrop']);
    });
    await step('When I click it', async () => {
      await userEvent.click(button());
    });
    await step('Then one sign-in was asked for and the button announces the modal it opened', async () => {
      await waitFor(() => expect(calls.signIns).toBe(1));
      await expect(storyModalOpen()).toBe(true);
      await waitFor(() => expect(popupAria()).toEqual(['dialog', 'true', 'auth-modal-backdrop']));
    });
  },
};

/**
 * As a screen-reader user, whenever I am not connected the button announces the auth modal, as a click starts a
 * login: signed out, or signed in with a pairing, a login or a failed login under way, the modal open or not.
 */
export const NotConnectedAnnouncesModal: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    const states = [
      { name: 'signed out', enter: disconnect, open: false },
      { name: 'signed out with the modal open', enter: disconnect, open: true },
      {
        name: 'signed in and not connected',
        enter: () => {
          connect(PG);
          notConnected();
        },
        open: true,
      },
      { name: 'signed in and not connected, the modal closed', enter: notConnected, open: false },
    ];
    for (const state of states) {
      await step(`When I am ${state.name}`, () => {
        state.enter();
        setModalOpen(state.open);
      });
      await step('Then the button announces the auth modal and whether it is open', async () => {
        await waitFor(() => expect(button()).toHaveAttribute('aria-controls', 'auth-modal-backdrop'));
        await expect(button()).toHaveAttribute('aria-haspopup', 'dialog');
        await expect(button()).toHaveAttribute('aria-expanded', storyModalOpen() ? 'true' : 'false');
      });
    }
  },
};

/**
 * As a logged-in screen-reader user, the button announces the account popover it opens only while connected, and
 * whether it is open.
 */
export const ConnectedAnnouncesPopover: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    connect(PG);
  },
  play: async ({ userEvent, step }) => {
    await step('Then the button announces the closed account popover', async () => {
      await expect(popupAria()).toEqual(['dialog', 'false', 'user-popover']);
      await expect(button()).toHaveAttribute('popovertarget', 'user-popover');
    });
    await step('When I open it', async () => {
      await userEvent.click(button());
    });
    await step('Then it announces it open, a dialog named Account', async () => {
      await waitFor(() => expect(button()).toHaveAttribute('aria-expanded', 'true'));
      await expect(byId('user-popover')).toHaveAttribute('role', 'dialog');
      await expect(byId('user-popover')).toHaveAttribute('aria-label', 'Account');
    });
    await step('When I press Escape', async () => {
      await userEvent.keyboard('{Escape}');
    });
    await step('Then it announces it closed', async () => {
      await waitFor(() => expect(button()).toHaveAttribute('aria-expanded', 'false'));
    });
    await step('When a pairing starts while I am logged in, which opens the auth modal', () => {
      notConnected();
      setModalOpen(true);
    });
    await step('Then my badge stays, but it announces the auth modal the pairing opened', async () => {
      await waitFor(() => expect(popupAria()).toEqual(['dialog', 'true', 'auth-modal-backdrop']));
      await expect(button().textContent).toBe('PG');
      await expect(storyModalOpen()).toBe(true);
      await expect(button()).not.toHaveAttribute('popovertarget');
    });
    await step('When I am connected again, which closes the auth modal', () => {
      connect(PG);
      setModalOpen(false);
    });
    await step('Then it is the account popover trigger again', async () => {
      await waitFor(() => expect(popupAria()).toEqual(['dialog', 'false', 'user-popover']));
      await expect(button()).toHaveAttribute('popovertarget', 'user-popover');
    });
  },
};

/** As a user signing out, I see a busy button named for the sign-out while the sign-out window reads. */
export const SigningOut: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    connect({ fullUsername: 'Alice Smith' });
    signingOut(true);
  },
  play: async ({ step }) => {
    await step('Then the button is busy, disabled and says it signs out', async () => {
      await expect(button()).toHaveAttribute('aria-busy', 'true');
      await expect(button()).toBeDisabled();
      await expect(button()).toHaveAttribute('title', 'Signing out');
    });
    await step('When the sign-out window has read', () => {
      signingOut(false);
    });
    await step('Then the button takes clicks again', async () => {
      await waitFor(() => expect(button()).not.toBeDisabled());
    });
  },
};

/** As a user whose saved sign-in cannot be reached, I see a busy reconnecting button that starts no sign-in. */
export const Unreachable: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    unreachable();
  },
  play: async ({ step }) => {
    await step('When I try to click it', () => {
      button().click();
    });
    await step('Then it is busy, disabled and named for the reconnect, and nothing started', async () => {
      await expect(button()).toHaveAttribute('aria-label', 'Reconnecting to your sign-in');
      await expect(button()).toHaveAttribute('aria-busy', 'true');
      await expect(button()).toBeDisabled();
      await expect(calls.signIns).toBe(0);
      await expect(storyModalOpen()).toBe(false);
    });
  },
};
