// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTIFICATION_DISMISS_MS, showNotification } from '../src/notification.js';
import { toastsStore } from '../src/state/toasts.js';
import { overlaysReady, resetOverlays } from './helpers/overlays.js';
import { byId, byTestId } from './support.js';

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

beforeEach(() => {
  setVisibility('visible');
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

afterEach(() => {
  resetOverlays();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('showNotification', () => {
  it('As a dotli integrator, a notification keeps the tone it is given, info by default', () => {
    // When
    showNotification({ label: 'Plain', text: 'Body' });
    showNotification({ label: 'Failed', text: 'Body', tone: 'err' });

    // Then
    expect(toastsStore.get().items.map(t => t.tone)).toEqual(['info', 'err']);
  });

  it('As a dotli user, a notification appears in the overlay root with the default bell icon', async () => {
    // When
    showNotification({ label: 'Hello', text: '  World  ' });
    await overlaysReady();

    // Then
    expect(byTestId('notif-title', byId('overlay-root')).textContent).toBe('Hello');
    expect(byTestId('notif-body', byId('overlay-root')).textContent).toBe('World');
    expect(document.querySelector('#overlay-root [data-testid="notif-icon"] svg')).not.toBeNull();
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
    expect(items[0]?.onActivate).toBeUndefined();
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

  it.each([
    { visibility: 'visible', focused: true, system: false },
    { visibility: 'visible', focused: false, system: true },
    { visibility: 'hidden', focused: true, system: true },
    { visibility: 'hidden', focused: false, system: true },
  ] as const)(
    'As a dotli user with visibility=$visibility and focused=$focused, system notification delivery is $system',
    ({ visibility, focused, system }) => {
      // Given
      vi.useFakeTimers();
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
      setVisibility(visibility);
      vi.spyOn(document, 'hasFocus').mockReturnValue(focused);

      try {
        // When
        showNotification({ label: 'Ping', text: 'Message' });
        showNotification({
          label: 'Quiet',
          text: 'No system one',
          browserNotification: false,
        });

        // Then: both stay available in-page, regardless of system delivery.
        expect(toastsStore.get().items.map(({ label, text }) => ({ label, text }))).toEqual([
          { label: 'Ping', text: 'Message' },
          { label: 'Quiet', text: 'No system one' },
        ]);
        expect(created).toEqual(system ? [{ title: 'Ping', body: 'Message' }] : []);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it('As a dotli user, a notification without its own icon shows the icon of its tone', async () => {
    // When
    showNotification({ label: 'Plain', text: 'Body' });
    showNotification({ label: 'Failed', text: 'Body', tone: 'err' });
    showNotification({ label: 'Blocked', text: 'Body', tone: 'idle' });
    showNotification({ label: 'Own', text: 'Body', tone: 'err', icon: '<svg data-own=""></svg>' });
    await overlaysReady();

    // Then
    const icons = [...document.querySelectorAll<HTMLElement>('#overlay-root [data-testid="notif-icon"]')];
    expect(icons.map(icon => icon.getAttribute('data-tone'))).toEqual(['info', 'err', 'idle', 'err']);
    expect(new Set(icons.slice(0, 3).map(icon => icon.innerHTML)).size).toBe(3);
    expect(icons[3]?.querySelector('svg[data-own]')).not.toBeNull();
  });
});
