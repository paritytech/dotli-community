// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The AuthModal island against the page's real stores: what it provides the view (the topbar's layer tracker and the
// product frame as the focus fallback) and the bar it brings back. A missing provider would fail silently, so these
// pin the wiring. The view itself is tested by the AuthModal story plays.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flush } from 'solid-js';
import { render } from '@solidjs/web';
import { resetAllStoresForTests, untilDom } from '@dotli/shared/testing';
import { byId } from '@dotli/ui/testing';
import type { AuthCommands } from '../../src/runtime/auth-commands.js';
import { createBlockingModalCoordinator } from '../../src/runtime/blocking-modal-queue.js';
import { initAuthController, startLogin } from '../../src/runtime/auth-controller.js';
import { setAuthState } from '../../src/runtime/state/auth.js';
import { resetAuthControllerForTests } from '../../src/runtime/auth-controller.js';
import { getTopbarState, reportBlockingModals, setTopbarVisible } from '../../src/state/topbar.js';
import { AuthModal } from '../../src/islands/AuthModal.js';
import { createProductFrameView } from '../../src/product-frame-view.js';
import { anyTopbarSurfaceOpen } from '../../src/state/topbar-surfaces.js';
import { authModalStore, setAuthModalTrigger } from '../../src/state/auth-modal.js';

/** What the controller asked of the bridge chunk's commands. */
const asked = { logins: 0, cancels: 0 };

const commands: AuthCommands = {
  login: () => {
    asked.logins += 1;
    return Promise.resolve();
  },
  logout: () => Promise.resolve(),
  cancelLogin: () => {
    asked.cancels += 1;
  },
};

let unmount: (() => void) | undefined;

/** Resolves once the page shows the modal open or closed, which it does after the controller wrote the state. */
async function untilModal(open: boolean): Promise<void> {
  await untilDom(() => (document.getElementById('auth-modal-backdrop')?.hasAttribute('data-open') ?? false) === open);
}

/** The island mounted as Astro hydrates it, with no saved session and the page's controller started. */
function mountIsland(): void {
  initAuthController({
    coordinator: createBlockingModalCoordinator({ report: reportBlockingModals }),
    commands: () => Promise.resolve(commands),
  });
  setAuthState({ tag: 'Disconnected' });
  const slot = document.createElement('div');
  document.body.append(slot);
  unmount = render(() => <AuthModal />, slot);
  flush();
}

beforeEach(() => {
  asked.logins = 0;
  asked.cancels = 0;
});

afterEach(() => {
  unmount?.();
  unmount = undefined;
  resetAuthControllerForTests();
  resetAllStoresForTests();
  document.body.replaceChildren();
  document.body.removeAttribute('style');
});

describe('AuthModal island', () => {
  it('As a dApp user with the bar folded, a sign-in brings the bar back and holds it while open, and Cancel cancels the login', async () => {
    // Given
    setTopbarVisible(false);
    mountIsland();

    // When
    startLogin();
    await untilModal(true);

    // Then
    expect(authModalStore.get().open).toBe(true);
    expect(getTopbarState().visible).toBe(true);
    expect(anyTopbarSurfaceOpen()).toBe(true);

    // When
    byId('auth-modal-close').click();
    await untilModal(false);

    // Then
    expect(authModalStore.get().open).toBe(false);
    expect(anyTopbarSurfaceOpen()).toBe(false);
    expect(asked.cancels).toBe(1);
  });

  it('As a dApp user, closing a sign-in whose account button left the page hands focus to the product frame', async () => {
    // Given: the product's frame attached, and a sign-in opened from the account button
    const frame = document.createElement('iframe');
    const button = document.createElement('button');
    document.body.append(frame, button);
    createProductFrameView({
      body: () => document.body,
      clearScreen: () => undefined,
      hideLoading: () => undefined,
    }).attachFrame(frame);
    const handBack = setAuthModalTrigger(button);
    mountIsland();
    button.focus();
    startLogin();
    await untilModal(true);

    // When: the button leaves the page, and I cancel
    button.remove();
    byId('auth-modal-close').click();
    await untilModal(false);

    // Then
    expect(document.activeElement).toBe(frame);
    handBack();
  });
});
