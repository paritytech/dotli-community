// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The pairing modal's lazy `qrcode` import resolving after the view moved
// on. A file of its own: a module is imported once per file, so only the
// first import can be held back.

import { describe, expect, it, vi } from 'vitest';
import { AuthModal } from '../../../src/components/shell/AuthModal.js';
import { setAuthState } from '../../../src/state/auth.js';
import { renderComponent } from '../../helpers/solid.js';
import { byId, settleAll, useAuthController } from './auth-harness.js';

const qr = vi.hoisted(() => {
  let release = (): void => {};
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  return { gate, release, toCanvas: vi.fn(() => Promise.resolve()) };
});
vi.mock('qrcode', async () => {
  await qr.gate;
  return { default: { toCanvas: qr.toCanvas } };
});

useAuthController();

async function settleQr(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
    await settleAll();
  }
}

describe('AuthModal late qrcode import', () => {
  it('As a user whose phone already scanned, a qrcode import that resolves late never replaces the login progress', async () => {
    // Given
    renderComponent(() => <AuthModal />);
    setAuthState({
      tag: 'Pairing',
      deeplink: 'polkadotapp://pair?handshake=test',
      label: 'localhost:3000',
    });
    await settleQr();
    expect(document.querySelector('#auth-modal-qr .spinner')).not.toBeNull();

    // When: the wallet approved before the import resolved.
    setAuthState({ tag: 'Authenticating' });
    await settleQr();
    qr.release();
    await settleQr();

    // Then: the import did resolve and draw, but nothing was inserted.
    expect(qr.toCanvas).toHaveBeenCalledTimes(1);
    expect(document.querySelector('#auth-modal-qr canvas')).toBeNull();
    expect(byId('auth-modal-qr').textContent).toContain('Logging in...');
  });
});
