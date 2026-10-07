// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Every store but the auth state skips a write that would not change it. The window events some setters dispatch
// still fire.

import { afterEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../../../metrics/src/sentry.js', () => sentry);

import { CHAT_AVAILABILITY_EVENT } from '@dotli/shared';
import type { ReadableStore } from '../../src/state/create-store.js';
import { resetStores } from '../helpers/solid.js';
import { getLoadingState, loadingStore, updateLoading } from '../../src/state/loading.js';
import {
  recordChainsButtonVisible,
  setBlockingModalActive,
  setTopbarVisible,
  topbarStore,
} from '../../src/state/topbar.js';
import {
  chatPanelStore,
  initChatPanelState,
  resetChatPanelStateForTests,
  setChatComposerError,
  setChatPanelWidth,
} from '../../src/state/chat-panel.js';
import { authModalStore, resetAuthModal, updateAuthModal } from '../../src/state/auth-modal.js';
import { clearToasts, resetToastsForTests, toastsStore } from '../../src/state/toasts.js';
import { authStore, loggedInStore, setAuthState, setLoggedIn } from '../../src/state/auth.js';
import { productStore, setProductError, setProductLoaded } from '../../src/state/product.js';
import { setTheme, themeStore } from '../../src/state/theme.js';
import {
  setVerificationShieldState,
  showLocalhostPill,
  showProductPill,
  urlPillStore,
} from '../../src/state/url-pill.js';

function countNotifications<T>(store: ReadableStore<T>): {
  count: () => number;
  stop: () => void;
} {
  let count = 0;
  const stop = store.subscribe(() => {
    count += 1;
  });
  return { count: () => count, stop };
}

function countEvents(name: string): { count: () => number; stop: () => void } {
  let count = 0;
  const listener = (): void => {
    count += 1;
  };
  window.addEventListener(name, listener);
  return {
    count: () => count,
    stop: () => {
      window.removeEventListener(name, listener);
    },
  };
}

afterEach(() => {
  resetStores();
  resetToastsForTests();
  resetChatPanelStateForTests();
});

describe('store equality', () => {
  it('As the loading screen, a frame that rewrites the same explanation notifies nobody', () => {
    // Given
    updateLoading({ explanation: 'Reaching out', explanationOpacity: 0.5 });
    const loading = countNotifications(loadingStore);

    // When: the typing loop writes the same frame again, twice.
    updateLoading({ explanation: 'Reaching out', explanationOpacity: 0.5 });
    updateLoading({ ...getLoadingState() });

    // Then
    expect(loading.count()).toBe(0);

    // When
    updateLoading({ explanationOpacity: 1 });

    // Then
    expect(loading.count()).toBe(1);
    loading.stop();
  });

  it('As the topbar, an unchanged visibility notifies nobody', () => {
    // Given: the topbar starts visible.
    const topbar = countNotifications(topbarStore);

    // When: the auto-hide reveal fires on every mouseenter.
    setTopbarVisible(true);
    setTopbarVisible(true);

    // Then
    expect(topbar.count()).toBe(0);

    // When
    setTopbarVisible(false);
    setTopbarVisible(false);

    // Then
    expect(topbar.count()).toBe(1);
    topbar.stop();
  });

  it('As the topbar, an unchanged blocking-modal flag or chains button notifies nobody', () => {
    // Given
    setBlockingModalActive(true);
    recordChainsButtonVisible(true);
    const topbar = countNotifications(topbarStore);

    // When
    setBlockingModalActive(true);
    recordChainsButtonVisible(true);

    // Then
    expect(topbar.count()).toBe(0);
    topbar.stop();
  });

  it('As the chat panel, a width drag past the clamp, a cleared composer error, an unchanged topbar and a repeated availability event notify nobody', () => {
    // Given
    const remove = initChatPanelState();
    window.dispatchEvent(
      new CustomEvent(CHAT_AVAILABILITY_EVENT, {
        detail: { label: 'app', chat: true },
      }),
    );
    setChatPanelWidth(10_000);
    const panel = countNotifications(chatPanelStore);

    // When
    setChatPanelWidth(10_000);
    setChatPanelWidth(900);
    setChatComposerError(null);
    setTopbarVisible(true);
    setBlockingModalActive(true);
    window.dispatchEvent(
      new CustomEvent(CHAT_AVAILABILITY_EVENT, {
        detail: { label: 'app', chat: true },
      }),
    );

    // Then
    expect(panel.count()).toBe(0);

    // When
    setChatPanelWidth(400);

    // Then
    expect(panel.count()).toBe(1);
    panel.stop();
    remove();
  });

  it('As the auth modal, rewriting the same fields and an equal view notifies nobody', () => {
    // Given
    updateAuthModal({
      open: true,
      view: { kind: 'pairing', payload: 'polkadotapp://pair?x' },
    });
    const modal = countNotifications(authModalStore);

    // When
    updateAuthModal({ open: true });
    updateAuthModal({
      view: { kind: 'pairing', payload: 'polkadotapp://pair?x' },
    });

    // Then
    expect(modal.count()).toBe(0);

    // When
    updateAuthModal({
      view: { kind: 'pairing', payload: 'polkadotapp://pair?y' },
    });
    resetAuthModal();
    resetAuthModal();

    // Then
    expect(modal.count()).toBe(2);
    modal.stop();
  });

  it('As the toasts, clearing an empty stack notifies nobody', () => {
    // Given
    const toasts = countNotifications(toastsStore);

    // When
    clearToasts();
    clearToasts();

    // Then
    expect(toasts.count()).toBe(0);
    toasts.stop();
  });

  it('As the auth controller, every auth step notifies, even the same object again, and dotli:truapi-auth-state fires every time', () => {
    // Given
    const step = { tag: 'Authenticating' } as const;
    setAuthState(step);
    const auth = countNotifications(authStore);
    const events = countEvents('dotli:truapi-auth-state');

    // When
    setAuthState(step);
    setAuthState(step);

    // Then
    expect(auth.count()).toBe(2);
    expect(events.count()).toBe(2);
    auth.stop();
    events.stop();
  });

  it('As the session store, an unchanged login notifies nobody and dotli:authenticated still fires every time', () => {
    // Given
    setLoggedIn(true);
    const session = countNotifications(loggedInStore);
    const events = countEvents('dotli:authenticated');

    // When
    setLoggedIn(true);

    // Then
    expect(session.count()).toBe(0);
    expect(events.count()).toBe(1);
    session.stop();
    events.stop();
  });

  it('As the product store, reloading the same product notifies nobody and dotli:product-loaded and dotli:product-error still fire every time', () => {
    // Given
    setProductLoaded('app', 'app.dot');
    const product = countNotifications(productStore);
    const loaded = countEvents('dotli:product-loaded');
    const errors = countEvents('dotli:product-error');

    // When
    setProductLoaded('app', 'app.dot');
    setProductError();
    setProductError();

    // Then
    expect(product.count()).toBe(1);
    expect(loaded.count()).toBe(1);
    expect(errors.count()).toBe(2);
    product.stop();
    loaded.stop();
    errors.stop();
  });

  it('As the theme store, an unchanged theme notifies nobody and dotli:theme-changed still fires every time', () => {
    // Given
    setTheme({ pref: 'light', resolved: 'light' });
    const theme = countNotifications(themeStore);
    const events = countEvents('dotli:theme-changed');

    // When
    setTheme({ pref: 'light', resolved: 'light' });

    // Then
    expect(theme.count()).toBe(0);
    expect(events.count()).toBe(1);
    theme.stop();
    events.stop();
  });

  it('As the URL pill, showing the same pill or shield again notifies nobody', () => {
    // Given
    showProductPill('app', '.dot');
    setVerificationShieldState('verified');
    const pill = countNotifications(urlPillStore);

    // When
    setVerificationShieldState('verified');

    // Then
    expect(pill.count()).toBe(0);

    // When
    showLocalhostPill('localhost:3000');
    showLocalhostPill('localhost:3000');

    // Then
    expect(pill.count()).toBe(1);
    pill.stop();
  });
});
