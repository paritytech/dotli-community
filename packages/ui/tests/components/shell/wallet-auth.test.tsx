// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as Config from '@dotli/config';
import { AuthButton } from '../../../src/components/shell/AuthButton.js';
import { getAuthModalState } from '../../../src/state/auth-modal.js';
import { getLoggedIn, setAuthState } from '../../../src/state/auth.js';
import { renderComponent } from '../../helpers/solid.js';
import { byId, recordEvents, settleAll, useAuthController } from './auth-harness.js';

const buildFlags = vi.hoisted(() => ({ debug: true }));
vi.mock('@dotli/config', async importOriginal => ({
  ...(await importOriginal<typeof Config>()),
  get DEBUG() {
    return buildFlags.debug;
  },
}));

useAuthController();
beforeEach(() => {
  buildFlags.debug = true;
  localStorage.setItem('dotli:local-wallet-enabled', '1');
});
afterEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('experimental-wallet-active');
});

it('keeps the unavailable test wallet reachable without authenticating or entering Mobile pairing', async () => {
  setAuthState({ tag: 'Connected', session: { connected: true, liteUsername: 'alice.02' } });
  renderComponent(() => <AuthButton />);
  await settleAll();
  setAuthState({ tag: 'WalletUnavailable', reason: 'Ownership moved to another tab' });
  await settleAll();
  const walletOpens = recordEvents('dotli:wallet-open');
  const logins = recordEvents('dotli:truapi-login-request');
  const button = byId('auth-button', HTMLButtonElement);
  expect(button.querySelector('[data-testid="user-badge-experimental"]')).not.toBeNull();
  expect(button.getAttribute('aria-controls')).toBe('td-wallet-view');
  button.click();
  await settleAll();
  expect(walletOpens.details).toHaveLength(1);
  expect(logins.details).toEqual([]);
  expect(getLoggedIn()).toBe(false);
  expect(getAuthModalState().open).toBe(false);
});

it('ignores a persisted browser-wallet opt-in in production and keeps normal Mobile login', async () => {
  buildFlags.debug = false;
  renderComponent(() => <AuthButton />);
  await settleAll();
  const walletOpens = recordEvents('dotli:wallet-open');
  const button = byId('auth-button', HTMLButtonElement);
  expect(button.querySelector('[data-testid="user-badge-experimental"]')).toBeNull();
  button.click();
  await settleAll();
  expect(walletOpens.details).toEqual([]);
  expect(getAuthModalState().open).toBe(true);
});
