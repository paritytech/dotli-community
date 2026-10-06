// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { AuthButton } from '../../../src/components/shell/AuthButton.js';
import { getAuthModalState } from '../../../src/state/auth-modal.js';
import { authStore, setAuthState } from '../../../src/state/auth.js';
import type { DotliAuthState } from '../../../src/host-callbacks/AuthState.js';
import { renderComponent } from '../../helpers/solid.js';
import { byTestId } from '../../support.js';
import { nth } from '../../helpers/nth.js';
import { byId, recordEvents, settleAll, useAuthController } from './auth-harness.js';

useAuthController();

const PUBLIC_KEY = '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

async function renderButton(props: { showName?: boolean; idPrefix?: string } = {}): Promise<HTMLButtonElement> {
  renderComponent(() => <AuthButton showName={props.showName} idPrefix={props.idPrefix} />);
  await settleAll();
  return byId(`${props.idPrefix ?? ''}auth-button`, HTMLButtonElement);
}

/**
 * What the button carries apart from styling: its id, label, no busy or
 * disabled state, the ARIA of a Radix-style trigger for what a click opens
 * (logged in, the user popover, and logged out, the auth modal), and its content:
 * the user icon and Sign in logged out, the avatar alone logged in (initials,
 * or the icon when the account has no username).
 */
function expectMarkup(button: Element, state: 'logged-out' | { initials: string | undefined }): void {
  const label = state === 'logged-out' ? 'Sign in with Polkadot Mobile' : 'Account';
  const account = state !== 'logged-out';
  expect(button.id).toBe('auth-button');
  expect(button.getAttribute('title')).toBe(label);
  expect(button.getAttribute('aria-label')).toBe(
    account && state.initials !== undefined ? `${state.initials}, account` : label,
  );
  expect(button.hasAttribute('disabled')).toBe(false);
  expect(button.hasAttribute('aria-busy')).toBe(false);
  expect(button.getAttribute('aria-haspopup')).toBe('dialog');
  expect(button.getAttribute('aria-expanded')).toBe(!account && getAuthModalState().open ? 'true' : 'false');
  expect(button.getAttribute('aria-controls')).toBe(account ? 'user-popover' : 'auth-modal-backdrop');
  if (state === 'logged-out') {
    expect(Array.from(button.children).map(child => child.tagName)).toEqual(['svg', 'SPAN']);
    expect(button.textContent.trim()).toBe('Sign in');
    return;
  }
  expect(Array.from(button.children).map(child => child.tagName)).toEqual(['SPAN']);
  const badge = nth(button.children, 0);
  if (state.initials !== undefined) {
    expect(badge.textContent).toBe(state.initials);
    expect(badge.children).toHaveLength(0);
  } else {
    expect(badge.textContent).toBe('');
    expect(Array.from(badge.children).map(child => child.tagName)).toEqual(['svg']);
  }
}

describe('AuthButton in the bar and on the landing page', () => {
  it('As a logged-out user in the bar, I see a Sign in button named for Polkadot Mobile', async () => {
    // When
    const button = await renderButton();

    // Then
    expect(button.textContent.trim()).toBe('Sign in');
    expect(button.getAttribute('aria-label')).toBe('Sign in with Polkadot Mobile');
    expect(button.getAttribute('aria-controls')).toBe('auth-modal-backdrop');
  });

  it('As a signed-in user in the bar, I see my initials alone, not my name', async () => {
    // Given
    const button = await renderButton();

    // When
    setAuthState({ tag: 'Connected', session: { connected: true, fullUsername: 'Alice Smith' } });
    await settleAll();

    // Then
    expect(byTestId('user-badge').textContent).toBe('AS');
    expect(button.textContent).not.toContain('Alice Smith');
    expect(button.getAttribute('aria-label')).toBe('AS, account');
    expect(button.getAttribute('aria-controls')).toBe('user-popover');
  });

  it('As a signed-in user whose name changes, the badge in the bar follows the new initials', async () => {
    // Given
    await renderButton();
    setAuthState({ tag: 'Connected', session: { connected: true, fullUsername: 'Alice Smith' } });
    await settleAll();

    // When
    setAuthState({ tag: 'Connected', session: { connected: true, fullUsername: 'Bob Jones' } });
    await settleAll();

    // Then
    expect(byTestId('user-badge').textContent).toBe('BJ');
  });

  it("As a signed-in user on the landing page, I see my initials and my name, which also start the button's name", async () => {
    // Given
    const button = await renderButton({ idPrefix: 'landing-', showName: true });

    // When
    setAuthState({ tag: 'Connected', session: { connected: true, fullUsername: 'Alice Smith' } });
    await settleAll();

    // Then
    expect(byTestId('user-badge').textContent).toBe('AS');
    expect(button.textContent).toContain('Alice Smith');
    expect(button.getAttribute('aria-label')).toBe('AS Alice Smith, account');
  });
});

describe('AuthButton', () => {
  it('As a dotli user, the button follows the auth store through one subscription', async () => {
    // Given
    const subscribe = vi.spyOn(authStore, 'subscribe');

    // When
    await renderButton();

    // Then
    expect(subscribe).toHaveBeenCalledTimes(1);
    subscribe.mockRestore();
  });

  it('As a logged-out user, I see the login button, enabled, with its ids, labels and ARIA state', async () => {
    // When
    const button = await renderButton();

    // Then
    expect(button.title).toBe('Sign in with Polkadot Mobile');
    expect(button.getAttribute('aria-label')).toBe('Sign in with Polkadot Mobile');
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.hasAttribute('aria-busy')).toBe(false);
    expect(button.querySelector('[data-testid="user-badge"]')).toBeNull();
    expectMarkup(button, 'logged-out');
  });

  it('As a logged-in user, I see my initials in the badge, with its ids, labels and ARIA state', async () => {
    // Given
    const button = await renderButton();

    // When
    setAuthState({
      tag: 'Connected',
      session: {
        connected: true,
        publicKey: PUBLIC_KEY,
        liteUsername: 'pgherveou.04',
        primaryUsername: 'pgherveou.04',
      },
    });
    await settleAll();

    // Then
    expect(button.textContent).toBe('PG');
    expect(button.title).toBe('Account');
    expectMarkup(button, { initials: 'PG' });
  });

  it('As a logged-in user with a full name, my badge shows the initials of my first two names', async () => {
    // Given
    const button = await renderButton();

    // When
    setAuthState({
      tag: 'Connected',
      session: { connected: true, fullUsername: 'ada  lovelace king' },
    });
    await settleAll();

    // Then
    expectMarkup(button, { initials: 'AL' });
  });

  it('As a logged-in user without a username, I see the anonymous badge, with its ids, labels and ARIA state', async () => {
    // Given
    const button = await renderButton();

    // When
    setAuthState({
      tag: 'Connected',
      session: { connected: true, publicKey: PUBLIC_KEY },
    });
    await settleAll();

    // Then
    const badge = byTestId('user-badge', button);
    expect(badge.hasAttribute('data-anon')).toBe(true);
    expect(badge.querySelector('svg')).not.toBeNull();
    expectMarkup(button, { initials: undefined });
  });

  it('As a logged-in user whose name contains markup, my badge shows it as text', async () => {
    // Given
    const button = await renderButton();

    // When
    setAuthState({
      tag: 'Connected',
      session: { connected: true, fullUsername: '<b>x</b>' },
    });
    await settleAll();

    // Then
    expect(button.querySelector('b')).toBeNull();
    expect(byTestId('user-badge', button).textContent).toBe('<B');
    expectMarkup(button, { initials: '<B' });
  });

  it('As a returning user whose session was restored before the islands loaded, the button shows my badge as it mounts', async () => {
    // Given: the boot rehydration ran before the chunk arrived.
    setAuthState({
      tag: 'Connected',
      session: { connected: true, liteUsername: 'pgherveou.04' },
    });

    // When
    const button = await renderButton();

    // Then
    expect(button.textContent).toBe('PG');
    expect(button.title).toBe('Account');
  });

  it('As a logged-in user, a pairing that starts elsewhere keeps my badge, and a disconnect brings the login button back', async () => {
    // Given
    const button = await renderButton();
    setAuthState({
      tag: 'Connected',
      session: { connected: true, liteUsername: 'pgherveou.04' },
    });
    await settleAll();

    // When
    setAuthState({
      tag: 'Pairing',
      deeplink: 'polkadotapp://pair?handshake=test',
      label: 'app',
    });
    await settleAll();

    // Then: only Connected and Disconnected change the button.
    expect(button.textContent).toBe('PG');

    // When
    setAuthState({ tag: 'Disconnected' });
    await settleAll();

    // Then
    expectMarkup(button, 'logged-out');
  });

  it('As a logged-out screen-reader user, the button announces the auth modal a click opens, and whether it is open', async () => {
    // Given
    const button = await renderButton();
    const popupAria = (): (string | null)[] =>
      ['aria-haspopup', 'aria-expanded', 'aria-controls'].map(name => button.getAttribute(name));

    // Then
    expect(popupAria()).toEqual(['dialog', 'false', 'auth-modal-backdrop']);

    // When
    button.click();
    await settleAll();

    // Then
    expect(getAuthModalState().open).toBe(true);
    expect(popupAria()).toEqual(['dialog', 'true', 'auth-modal-backdrop']);
  });

  it.each<[string, DotliAuthState]>([
    ['Disconnected', { tag: 'Disconnected' }],
    [
      'Pairing',
      {
        tag: 'Pairing',
        deeplink: 'polkadotapp://pair?handshake=test',
        label: 'app',
      },
    ],
    ['Authenticating', { tag: 'Authenticating' }],
    ['LoginFailed', { tag: 'LoginFailed', kind: 'Other', reason: 'Host failure' }],
  ])(
    'As a screen-reader user, while the auth state is %s the button announces the auth modal, as a click starts a login',
    async (_tag, state) => {
      // Given
      const button = await renderButton();

      // When
      setAuthState(state);
      await settleAll();

      // Then
      expect(button.getAttribute('aria-haspopup')).toBe('dialog');
      expect(button.getAttribute('aria-controls')).toBe('auth-modal-backdrop');
      expect(button.getAttribute('aria-expanded')).toBe(getAuthModalState().open ? 'true' : 'false');
    },
  );

  it('As a logged-in screen-reader user, the button announces the user popover only while connected, when a click opens it', async () => {
    // Given
    const button = await renderButton();
    const popupAria = (): (string | null)[] =>
      ['aria-haspopup', 'aria-expanded', 'aria-controls'].map(name => button.getAttribute(name));
    setAuthState({
      tag: 'Connected',
      session: { connected: true, liteUsername: 'pgherveou.04' },
    });
    await settleAll();

    // Then
    expect(popupAria()).toEqual(['dialog', 'false', 'user-popover']);

    // When: a pairing starts while logged in, so a click starts a login.
    setAuthState({
      tag: 'Pairing',
      deeplink: 'polkadotapp://pair?handshake=test',
      label: 'app',
    });
    await settleAll();

    // Then: still showing the badge, but announcing the auth modal, which
    // the pairing opened.
    expect(button.textContent).toBe('PG');
    expect(getAuthModalState().open).toBe(true);
    expect(popupAria()).toEqual(['dialog', 'true', 'auth-modal-backdrop']);

    // When
    setAuthState({ tag: 'Authenticating' });
    await settleAll();

    // Then
    expect(popupAria()).toEqual(['dialog', getAuthModalState().open ? 'true' : 'false', 'auth-modal-backdrop']);

    // When
    setAuthState({
      tag: 'Connected',
      session: { connected: true, liteUsername: 'pgherveou.04' },
    });
    await settleAll();

    // Then
    expect(popupAria()).toEqual(['dialog', 'false', 'user-popover']);
  });

  it('As a logged-out user, clicking the button requests a login and opens the pairing modal', async () => {
    // Given
    const loginRequests = recordEvents('dotli:truapi-login-request');
    const button = await renderButton();

    // When
    button.click();
    await settleAll();

    // Then
    expect(loginRequests.details).toEqual([{ reason: undefined }]);
    expect(getAuthModalState().open).toBe(true);
    expect(getAuthModalState().productLabel).toBeNull();
  });
});
