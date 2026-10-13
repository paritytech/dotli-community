// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pushToast, toastsStore } from '../page/state/toasts.js';
import { FakePage } from '@dotli/shared/testing';
import { bindToastPage, resetToastsForTests } from '../testing/index.js';
import { createNotifier, NOTIFICATION_DISMISS_MS, type SystemNotifications } from './notification.js';

let page: FakePage;
let system: SystemNotifications | undefined;

/** The notifier over the toast store, on a page whose visibility the test sets. */
const showNotification = createNotifier({
  present: input => {
    pushToast(input);
  },
  visible: () => page.visibilityState === 'visible',
  system: () => system,
});

beforeEach(() => {
  page = new FakePage();
  bindToastPage(page);
  system = undefined;
});

afterEach(() => {
  resetToastsForTests();
});

describe('showNotification', () => {
  it('As a dotli integrator, a notification keeps the tone it is given, info by default', () => {
    // When
    showNotification({ label: 'Plain', text: 'Body' });
    showNotification({ label: 'Failed', text: 'Body', tone: 'err' });

    // Then
    expect(toastsStore.get().items.map(t => t.tone)).toEqual(['info', 'err']);
  });

  it('As a dotli user, a notification shows its title, its trimmed text, and leaves the icon to its tone', () => {
    // When
    showNotification({ label: 'Hello', text: '  World  ' });

    // Then
    const [toast] = toastsStore.get().items;
    expect(toast?.label).toBe('Hello');
    expect(toast?.text).toBe('World');
    expect(toast?.icon).toBeUndefined();
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
    system = FakeNotification as unknown as SystemNotifications;
    page.setVisibility('hidden');

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

  it('As a dotli user, a notification keeps the icon it was given and carries none otherwise', () => {
    // Given
    const ownIcon = (): null => null;

    // When
    showNotification({ label: 'Plain', text: 'Body' });
    showNotification({ label: 'Failed', text: 'Body', tone: 'err' });
    showNotification({ label: 'Blocked', text: 'Body', tone: 'idle' });
    showNotification({ label: 'Own', text: 'Body', tone: 'err', icon: ownIcon });

    // Then
    const items = toastsStore.get().items;
    expect(items.map(t => t.tone)).toEqual(['info', 'err', 'idle', 'err']);
    expect(items.map(t => t.icon)).toEqual([undefined, undefined, undefined, ownIcon]);
  });
});
