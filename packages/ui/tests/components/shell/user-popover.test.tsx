// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthButton } from '../../../src/components/shell/AuthButton.js';
import { requestTruapiDisconnect } from '../../../src/auth-controller.js';
import { setAuthState } from '../../../src/state/auth.js';
import { setBlockingModalActive } from '../../../src/state/topbar.js';
import type { TruapiSessionUiState } from '../../../src/host-callbacks/SessionStore.js';
import { pointerPress, pointerPressUnfocusable, renderComponent, tabTo, waitForContent } from '../../helpers/solid.js';
import { byId, press, recordEvents, settleAll, useAuthController } from './auth-harness.js';
import { byTestId, query } from '../../support.js';
import { nth } from '../../helpers/nth.js';

useAuthController();

afterEach(() => {
  vi.unstubAllGlobals();
});

const PUBLIC_KEY = '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

/** The button and the popover, as their island, plus a button outside. */
async function renderAccount(session?: TruapiSessionUiState): Promise<HTMLElement> {
  renderComponent(() => (
    <div>
      <AuthButton />
      <button id="outside" type="button">
        Outside
      </button>
    </div>
  ));
  await settleAll();
  if (session !== undefined) {
    setAuthState({ tag: 'Connected', session });
    await settleAll();
  }
  return byId('user-popover');
}

function isOpen(): boolean {
  return byId('user-popover').hasAttribute('data-open');
}

/**
 * The popover: a Radix-style non-modal popover surface (role="dialog", named
 * "Account", with the tabindex that lets it take focus) whose body leads with
 * the avatar, "Welcome back" and the name, then the hint, a divider and Log out.
 */
function expectMarkup(
  popover: Element,
  opts: { username: string; hint: boolean; open: boolean; initials?: string },
): void {
  expect(popover.getAttribute('role')).toBe('dialog');
  expect(popover.getAttribute('aria-label')).toBe('Account');
  expect(popover.getAttribute('tabindex')).toBe('-1');
  expect(popover.hasAttribute('data-open')).toBe(opts.open);
  const body = query(popover, ':scope > [data-testid="popover-body"]');
  const content = query(body, ':scope > [data-testid="account-content"]');
  const parts = Array.from(content.children);
  expect(parts.map(child => child.tagName)).toEqual(
    opts.hint ? ['DIV', 'DIV', 'HR', 'BUTTON'] : ['DIV', 'HR', 'BUTTON'],
  );
  const identity = nth(parts, 0);
  const [avatar, text] = Array.from(identity.children) as [HTMLElement, HTMLElement];
  if (opts.initials === undefined) {
    expect(avatar.querySelector('svg')).not.toBeNull();
  } else {
    expect(avatar.textContent).toBe(opts.initials);
  }
  const nameParts = Array.from(text.children);
  expect(nameParts.map(child => child.tagName)).toEqual(['DIV', 'DIV']);
  expect(nameParts[0]?.textContent).toBe('Welcome back');
  expect(nameParts[1]?.id).toBe('user-popover-username');
  expect(nameParts[1]?.textContent).toBe(opts.username);
  if (opts.hint) {
    const hint = byId('user-popover-hint');
    expect(nth(parts, 1).contains(hint)).toBe(true);
    expect(hint.textContent).toBe('No username found for this account on this network.');
  }
  const divider = nth(parts, parts.length - 2);
  expect(divider.childNodes).toHaveLength(0);
  const disconnect = nth(parts, parts.length - 1);
  expect(disconnect.id).toBe('user-popover-disconnect');
  expect(disconnect.querySelector('svg')).not.toBeNull();
  expect(disconnect.textContent).toBe('Log out');
}

/** Open the popover, and wait for its body (its own chunk). */
async function openPopover(): Promise<void> {
  byId('auth-button').click();
  await settleAll();
  expect(isOpen()).toBe(true);
  await waitForContent('user-popover');
}

describe('UserPopover', () => {
  it('As a logged-in user, the popover shows my username, with its ids, labels and ARIA state', async () => {
    // When
    const popover = await renderAccount({
      connected: true,
      publicKey: PUBLIC_KEY,
      liteUsername: 'pgherveou.04',
      primaryUsername: 'pgherveou.04',
    });
    await openPopover();

    // Then
    expect(byId('user-popover-username').textContent).toBe('pgherveou.04');
    expect(document.getElementById('user-popover-hint')).toBeNull();
    expectMarkup(popover, {
      username: 'pgherveou.04',
      hint: false,
      open: true,
      initials: 'PG',
    });
  });

  it('As a user whose name changes, the avatar in the popover follows the new initials', async () => {
    // Given
    await renderAccount({ connected: true, publicKey: PUBLIC_KEY, fullUsername: 'Alice Smith' });
    await openPopover();
    const avatar = nth(Array.from(byTestId('account-content').firstElementChild?.children ?? []), 0);
    expect(avatar.textContent).toBe('AS');

    // When
    setAuthState({ tag: 'Connected', session: { connected: true, publicKey: PUBLIC_KEY, fullUsername: 'Bob Jones' } });
    await settleAll();

    // Then
    expect(avatar.textContent).toBe('BJ');
  });

  it('As a user whose account has no username, the popover shows my shortened address and explains why', async () => {
    // When
    const popover = await renderAccount({
      connected: true,
      publicKey: PUBLIC_KEY,
    });
    await openPopover();

    // Then
    expect(byId('user-popover-username').textContent).toBe('0x000102...1e1f');
    expect(byId('user-popover-hint').textContent).toContain('No username');
    expectMarkup(popover, {
      username: '0x000102...1e1f',
      hint: true,
      open: true,
    });

    // When: reconnecting with a username clears the hint again.
    setAuthState({
      tag: 'Connected',
      session: { connected: true, liteUsername: 'pgherveou.04' },
    });
    await settleAll();

    // Then
    expect(byId('user-popover-username').textContent).toBe('pgherveou.04');
    expect(document.getElementById('user-popover-hint')).toBeNull();
  });

  it('As a user restored from a bare session, the popover says I am connected', async () => {
    // When
    const popover = await renderAccount({ connected: true });
    await openPopover();

    // Then
    expectMarkup(popover, {
      username: 'Connected with Polkadot Mobile',
      hint: true,
      open: true,
    });
  });

  it('As a phone user, my account opens as a sheet titled Account, its body without a heading of its own', async () => {
    // Given
    vi.stubGlobal('matchMedia', (media: string) => ({
      matches: media === '(max-width: 560px)',
      media,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    await renderAccount({ connected: true, liteUsername: 'pgherveou.04' });

    // When
    await openPopover();

    // Then
    expect(byId('user-popover').hasAttribute('data-sheet')).toBe(true);
    expect(byTestId('popover-sheet-title').textContent).toBe('Account');
    expect(byTestId('account-content').hasAttribute('data-sheet')).toBe(true);
    expect(byTestId('account-content').querySelector('h2')).toBeNull();
  });

  it('As a user whose username contains markup, the popover shows it as text', async () => {
    // When
    const popover = await renderAccount({
      connected: true,
      primaryUsername: '<b>x</b>',
    });
    await openPopover();

    // Then
    expect(popover.querySelector('b')).toBeNull();
    expect(byId('user-popover-username').textContent).toBe('<b>x</b>');
  });

  it('As a logged-out user, the popover has no hint', async () => {
    // Given
    await renderAccount({ connected: true, publicKey: PUBLIC_KEY });

    // When
    setAuthState({ tag: 'Disconnected' });
    await settleAll();

    // Then
    expect(document.getElementById('user-popover-hint')).toBeNull();
  });

  it('As a logged-in user, the account button toggles the popover and Log out requests a disconnect through the Rust core', async () => {
    // Given
    const disconnects = recordEvents('dotli:truapi-disconnect-request');
    const loginRequests = recordEvents('dotli:truapi-login-request');
    await renderAccount({ connected: true, liteUsername: 'pgherveou.04' });

    // When
    await openPopover();
    byId('auth-button').click();
    await settleAll();

    // Then
    expect(isOpen()).toBe(false);

    // When
    await openPopover();
    byId('user-popover-disconnect').click();
    await settleAll();

    // Then
    expect(disconnects.details).toHaveLength(1);
    expect(isOpen()).toBe(false);
    expect(loginRequests.details).toHaveLength(0);
  });

  it('As a dotli integrator, the controller emits the Rust-core disconnect request', () => {
    // Given
    const disconnects = recordEvents('dotli:truapi-disconnect-request');

    // When
    requestTruapiDisconnect();

    // Then
    expect(disconnects.details).toHaveLength(1);
  });

  it('As a keyboard user, the open popover takes focus, traps Tab and closes on Escape, handing focus back to the account button', async () => {
    // Given
    await renderAccount({ connected: true, liteUsername: 'pgherveou.04' });
    byId('auth-button').focus();

    // When
    await openPopover();

    // Then: Log out is the only control.
    expect(document.activeElement).toBe(byId('user-popover-disconnect'));

    // When
    const tab = press('Tab');

    // Then: Tab loops inside the popover, onto its only control.
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId('user-popover-disconnect'));

    // When
    press('Escape');
    await settleAll();

    // Then
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(byId('auth-button'));
  });

  it('As a screen-reader user, the account button announces the popover it opens and whether it is open', async () => {
    // Given
    const popover = await renderAccount({
      connected: true,
      liteUsername: 'pgherveou.04',
    });
    const button = byId('auth-button');

    // Then
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(popover.getAttribute('aria-label')).toBe('Account');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-controls')).toBe('user-popover');
    expect(button.getAttribute('aria-expanded')).toBe('false');

    // When
    await openPopover();

    // Then
    expect(button.getAttribute('aria-expanded')).toBe('true');

    // When
    press('Escape');
    await settleAll();

    // Then
    expect(button.getAttribute('aria-expanded')).toBe('false');

    // When: logging out turns the button back into the login button.
    setAuthState({ tag: 'Disconnected' });
    await settleAll();

    // Then: it announces the auth modal a click now opens instead.
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe('auth-modal-backdrop');
  });

  it('As a keyboard user, Tab past Log out keeps focus in the popover and leaves it open', async () => {
    // Given
    await renderAccount({ connected: true, liteUsername: 'pgherveou.04' });
    byId('auth-button').focus();
    await openPopover();
    expect(document.activeElement).toBe(byId('user-popover-disconnect'));

    // When
    const tab = tabTo(byId('outside'));
    await settleAll();

    // Then
    expect(tab.defaultPrevented).toBe(true);
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(byId('user-popover-disconnect'));
  });

  it('As a logged-in user, a press outside closes the popover without handing focus back to the account button', async () => {
    // Given
    await renderAccount({ connected: true, liteUsername: 'pgherveou.04' });
    byId('auth-button').focus();
    await openPopover();

    // When: the press lands on nothing that takes focus.
    pointerPressUnfocusable(document.body);
    await settleAll();

    // Then: focus follows the press, as in a Radix non-modal popover.
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it('As a logged-in user, a click outside closes the popover', async () => {
    // Given
    await renderAccount({ connected: true, liteUsername: 'pgherveou.04' });
    await openPopover();

    // When
    byId('user-popover-username').click();
    await settleAll();

    // Then
    expect(isOpen()).toBe(true);

    // When
    pointerPress(byId('outside'));
    await settleAll();

    // Then
    expect(isOpen()).toBe(false);
  });

  it('As a logged-in user, a blocking modal coming up closes the popover', async () => {
    // Given
    await renderAccount({ connected: true, liteUsername: 'pgherveou.04' });
    await openPopover();

    // When
    setBlockingModalActive(true);
    await settleAll();

    // Then
    expect(isOpen()).toBe(false);
  });

  it('As a returning user whose session was restored before the islands loaded, the popover shows my username as it mounts', async () => {
    // Given
    setAuthState({
      tag: 'Connected',
      session: { connected: true, primaryUsername: 'alice' },
    });

    // When
    await renderAccount();
    await openPopover();

    // Then
    expect(byId('user-popover-username').textContent).toBe('alice');
  });
});
