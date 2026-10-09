// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthButton } from '../../../src/components/shell/AuthButton.js';
import { requestTruapiDisconnect } from '../../../src/auth-controller.js';
import { setAuthState } from '../../../src/state/auth.js';
import type { TruapiSessionUiState } from '../../../src/host-callbacks/SessionStore.js';
import { popoverBody, renderComponent, waitForContent } from '../../helpers/solid.js';
import { byId, press, recordEvents, settleAll, useAuthController } from './auth-harness.js';
import { byTestId, must, query } from '../../support.js';
import { nth } from '../../helpers/nth.js';
import { stubPhoneViewport } from '../../helpers/viewport.js';
import { useFloatingSurfaces } from '../../helpers/floating.js';

useAuthController();

afterEach(() => {
  vi.unstubAllGlobals();
});

const PUBLIC_KEY = '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

/** The island plus a button outside. Returns a getter, as the popover is in the page only from its first opening. */
async function renderAccount(session?: TruapiSessionUiState): Promise<() => HTMLElement> {
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
  return () => byId('user-popover');
}

function isOpen(): boolean {
  return document.getElementById('user-popover')?.hasAttribute('data-open') === true;
}

/** The popover apart from styling. */
function expectMarkup(
  popover: Element,
  opts: { username: string; hint: boolean; open: boolean; initials?: string },
): void {
  expect(popover.getAttribute('role')).toBe('dialog');
  expect(popover.getAttribute('aria-label')).toBe('Account');
  expect(popover.getAttribute('tabindex')).toBe('-1');
  expect(popover.hasAttribute('data-open')).toBe(opts.open);
  const body = must(popoverBody('user-popover'), '#user-popover');
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

async function openPopover(): Promise<void> {
  byId('auth-button').click();
  await settleAll();
  expect(isOpen()).toBe(true);
  await waitForContent('user-popover');
}

useFloatingSurfaces();

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
    expectMarkup(popover(), {
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
    expectMarkup(popover(), {
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
    expectMarkup(popover(), {
      username: 'Connected with Polkadot Mobile',
      hint: true,
      open: true,
    });
  });

  it('As a phone user, my account opens as a sheet titled Account, its body without a heading of its own', async () => {
    // Given
    stubPhoneViewport(true);
    await renderAccount({ connected: true, liteUsername: 'pgherveou.04' });

    // When
    await openPopover();

    // Then
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
    expect(popover().querySelector('b')).toBeNull();
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

  it('As a logged-in user, Log out requests a disconnect through the Rust core and closes the popover', async () => {
    // Given
    const disconnects = recordEvents('dotli:truapi-disconnect-request');
    const loginRequests = recordEvents('dotli:truapi-login-request');
    await renderAccount({ connected: true, liteUsername: 'pgherveou.04' });

    // When
    await openPopover();
    byId('user-popover-disconnect').click();
    await settleAll();

    // Then
    expect(disconnects.details).toHaveLength(1);
    expect(isOpen()).toBe(false);
    expect(loginRequests.details).toHaveLength(0);
  });

  it('As a signed-in user whose session drops while my account is open, it closes and focus goes back to the button', async () => {
    // Given
    await renderAccount({ connected: true, liteUsername: 'pgherveou.04' });
    await openPopover();
    byId('user-popover-disconnect').focus();

    // When
    setAuthState({ tag: 'Disconnected' });
    await settleAll();

    // Then
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(byId('auth-button'));
    expect(byId('auth-button').getAttribute('aria-expanded')).toBe('false');
    expect(byId('auth-button').getAttribute('aria-controls')).toBe('auth-modal-backdrop');
  });

  it('As a dotli integrator, the controller emits the Rust-core disconnect request', () => {
    // Given
    const disconnects = recordEvents('dotli:truapi-disconnect-request');

    // When
    requestTruapiDisconnect();

    // Then
    expect(disconnects.details).toHaveLength(1);
  });

  it('As a screen-reader user, the account button announces the popover it opens and whether it is open', async () => {
    // Given
    const popover = await renderAccount({
      connected: true,
      liteUsername: 'pgherveou.04',
    });
    const button = byId('auth-button');

    // Then
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-controls')).toBe('user-popover');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('popovertarget')).toBe('user-popover');

    // When
    await openPopover();

    // Then
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(popover().getAttribute('role')).toBe('dialog');
    expect(popover().getAttribute('aria-label')).toBe('Account');

    // When
    press('Escape');
    await settleAll();

    // Then
    expect(button.getAttribute('aria-expanded')).toBe('false');

    // When: logging out turns the button back into the login button.
    setAuthState({ tag: 'Disconnected' });
    await settleAll();

    // Then: it announces the auth modal a click now opens instead, and invokes no popover.
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe('auth-modal-backdrop');
    expect(button.hasAttribute('popovertarget')).toBe(false);
    expect(button.style.getPropertyValue('anchor-name')).toBe('');

    // When: logging in again.
    setAuthState({ tag: 'Connected', session: { connected: true, liteUsername: 'pgherveou.04' } });
    await settleAll();

    // Then: it is the popover's trigger again.
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe('user-popover');
    expect(button.getAttribute('popovertarget')).toBe('user-popover');
    expect(button.style.getPropertyValue('anchor-name')).toBe('--anchor-user-popover');
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
