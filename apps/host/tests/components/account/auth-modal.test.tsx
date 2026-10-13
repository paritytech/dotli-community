// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The modal's scroll lock against the inline body overflow bridge.ts writes as the product frame attaches: two layers
// meeting on the page. The modal itself is tested by the AuthModal story plays.

import { afterEach, describe, expect, it } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from '@solidjs/web';
import type { AuthModalState } from '../../../src/state/auth-modal.js';
import { AuthModal } from '../../../src/components/account/AuthModal.js';
import { untilDom } from '@dotli/shared/testing';
import { appears, byId } from '@dotli/ui/testing';

const CLOSED: AuthModalState = { open: false, productLabel: null, reason: null, view: { kind: 'spinner' } };

let unmount: (() => void) | undefined;

afterEach(() => {
  unmount?.();
  unmount = undefined;
  document.body.innerHTML = '';
});

function isOpen(): boolean {
  return byId('auth-modal-backdrop').hasAttribute('data-open');
}

function scrollLocked(): boolean {
  return document.body.hasAttribute('data-scroll-locked');
}

describe('AuthModal and the product frame', () => {
  it('As a user who opened the modal while a product was loading, the overflow the product frame hides as it attaches stays hidden once the modal closes', async () => {
    // Given an open modal whose pairing code has been drawn
    const [state, setState] = createSignal(CLOSED);
    const container = document.createElement('div');
    document.body.append(container);
    unmount = render(
      () => (
        <AuthModal
          state={state}
          onClose={() => setState(CLOSED)}
          onRetry={() => undefined}
          drawQr={() => Promise.resolve()}
          isMobile={() => false}
        />
      ),
      container,
    );
    setState({
      open: true,
      productLabel: 'localhost:3000',
      reason: null,
      view: { kind: 'pairing', payload: 'polkadotapp://pair?handshake=test' },
    });
    await appears('[data-testid="auth-modal-qr-tile"]');
    expect(isOpen()).toBe(true);
    expect(scrollLocked()).toBe(true);

    // When: the product frame attaches, and bridge.ts hides the body's
    // overflow; then the modal closes.
    document.body.style.overflow = 'hidden';
    byId('auth-modal-close').click();
    await untilDom(() => !scrollLocked());

    // Then
    expect(isOpen()).toBe(false);
    expect(document.body.style.overflow).toBe('hidden');
    document.body.style.overflow = '';
  });
});
