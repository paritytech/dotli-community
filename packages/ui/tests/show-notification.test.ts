// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTIFICATION_DISMISS_MS, showNotification } from '../src/notification.js';
import { toastsStore } from '../src/state/toasts.js';
import { overlaysReady, resetOverlays } from './helpers/overlays.js';

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

beforeEach(() => {
  setVisibility('visible');
});

afterEach(() => {
  resetOverlays();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('showNotification', () => {
  it('As a dotli user, a notification appears in the overlay root with the default bell icon', async () => {
    // When
    showNotification({ label: 'Hello', text: '  World  ' });
    await overlaysReady();

    // Then
    expect(document.querySelector('#overlay-root .notif-title')?.textContent).toBe('Hello');
    expect(document.querySelector('#overlay-root .notif-body')?.textContent).toBe('World');
    expect(document.querySelector('#overlay-root .notif-icon svg')).not.toBeNull();
  });

  it('As a dotli integrator, empty text shows nothing, long text is cut to 200 characters, and non-http links are dropped', () => {
    // When
    showNotification({ label: 'Empty', text: '   ' });
    showNotification({
      label: 'Long',
      text: 'x'.repeat(250),
      deeplink: 'javascript:alert(1)',
    });

    // Then
    const items = toastsStore.get().items;
    expect(items.map(t => t.label)).toEqual(['Long']);
    expect(items[0]?.text).toHaveLength(200);
    expect(items[0]?.deeplink).toBeUndefined();
  });

  it('As a dotli user, a notification leaves after the default delay', () => {
    // Given
    vi.useFakeTimers();
    showNotification({ label: 'Timed', text: 'Body' });

    // When
    vi.advanceTimersByTime(NOTIFICATION_DISMISS_MS);

    // Then
    expect(toastsStore.get().items.map(t => t.leaving)).toEqual([true]);
    vi.useRealTimers();
  });

  it('As a dotli user with the tab hidden, I also get a system notification when permission is granted', () => {
    // Given
    const created: { title: string; body: string | undefined }[] = [];
    class FakeNotification {
      static permission = 'granted';
      static requestPermission = vi.fn();
      onclick: (() => void) | null = null;
      constructor(title: string, options?: { body?: string }) {
        created.push({ title, body: options?.body });
      }
      close(): void {}
    }
    vi.stubGlobal('Notification', FakeNotification);
    setVisibility('hidden');

    // When
    showNotification({ label: 'Ping', text: 'Background' });
    showNotification({
      label: 'Quiet',
      text: 'No system one',
      browserNotification: false,
    });

    // Then
    expect(created).toEqual([{ title: 'Ping', body: 'Background' }]);
  });
});
