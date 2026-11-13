// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import {
  createFakePage,
  createManualTimers,
  resetAllStoresForTests,
  type FakePage,
  type ManualTimers,
} from '@dotli/shared/testing';
import { createToasts } from '../page/state/createToasts.js';
import { createNotifier, NOTIFICATION_DISMISS_MS, type SystemNotifications } from './createNotifier.js';

let page: FakePage;
let timers: ManualTimers;
let toasts: ReturnType<typeof createToasts>;
let system: SystemNotifications | undefined;
let closed: string[];
let focused: boolean;
let showNotification: ReturnType<typeof createNotifier>;

beforeEach(() => {
  page = createFakePage();
  timers = createManualTimers();
  toasts = createToasts({ page: page.document, timers });
  system = undefined;
  closed = [];
  focused = true;
  // The notifier over this toast stack, on a page whose visibility and focus the test sets.
  showNotification = createNotifier({
    toasts,
    attended: () => page.document.visibilityState === 'visible' && focused,
    system: () => system,
    timers,
  });
});

afterEach(() => {
  resetAllStoresForTests();
});

describe('showNotification', () => {
  it('As a dotli user, I get a notification and see its title and trimmed text, with the icon left to its tone', () => {
    // When
    showNotification({ label: 'Hello', text: '  World  ' });

    // Then
    const [toast] = toasts.store.get().items;
    expect(toast?.label).toBe('Hello');
    expect(toast?.text).toBe('World');
    expect(toast?.icon).toBeUndefined();
  });

  it('As a dotli integrator, I notify with empty text, long text and a non-http link, and get nothing, text cut to 200 characters and no link', () => {
    // When
    showNotification({ label: 'Empty', text: '   ' });
    showNotification({
      label: 'Long',
      text: 'x'.repeat(250),
      deeplink: 'javascript:alert(1)',
    });

    // Then
    const items = toasts.store.get().items;
    expect(items.map(toast => toast.label)).toEqual(['Long']);
    expect(items[0]?.text).toHaveLength(200);
    expect(items[0]?.deeplink).toBeUndefined();
  });

  it('As a dotli user with the tab hidden, I get a notification and a system one too when permission is granted', () => {
    // Given
    const created = grantSystem();
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

  it('As a dotli user looking at the page, I get a notification and only the in-page one', () => {
    // Given
    const created = grantSystem();

    // When
    showNotification({ label: 'Ping', text: 'Here' });

    // Then
    expect(created).toEqual([]);
    expect(toasts.store.get().items.map(toast => toast.text)).toEqual(['Here']);
  });

  it('As a dotli user away from the window, I get a system notification and it closes itself after 5 s', async () => {
    // Given
    grantSystem();
    focused = false;
    showNotification({ label: 'Ping', text: 'Closing' });

    // When
    await timers.advance(4999);
    const closedBefore = [...closed];
    await timers.advance(1);

    // Then
    expect(closedBefore).toEqual([]);
    expect(closed).toEqual(['Ping']);
  });

  it('As a dotli user away from the window with system notifications blocked, I get a notification and find it still in the page', async () => {
    // Given
    toasts.show();
    installSystemAt('denied');
    focused = false;

    // When
    showNotification({ label: 'Ping', text: 'Kept' });
    await timers.advance(NOTIFICATION_DISMISS_MS);

    // Then
    expect(readLeaving()).toEqual([false]);
  });

  it('As a dotli user away from the window in a browser with no system notifications, I get a notification and find it still in the page', async () => {
    // Given
    toasts.show();
    focused = false;

    // When
    showNotification({ label: 'Ping', text: 'Kept' });
    await timers.advance(NOTIFICATION_DISMISS_MS);

    // Then
    expect(readLeaving()).toEqual([false]);
  });

  it('As a dotli user away from the window, I get a notification the system showed and it leaves the page after the default delay', async () => {
    // Given
    toasts.show();
    grantSystem();
    focused = false;

    // When
    showNotification({ label: 'Ping', text: 'Shown' });
    await timers.advance(NOTIFICATION_DISMISS_MS);

    // Then
    expect(readLeaving()).toEqual([true]);
  });

  it('As a dotli user away from the window, I grant system notifications when asked and the toast leaves the page after the default delay', async () => {
    // Given
    toasts.show();
    focused = false;
    const granted = Promise.resolve<NotificationPermission>('granted');
    installSystemAt('default', () => granted);

    // When
    showNotification({ label: 'Ping', text: 'Granted' });
    // Settles after the notifier's own handler, which was attached first.
    await granted;
    await timers.advance(NOTIFICATION_DISMISS_MS);

    // Then
    expect(readLeaving()).toEqual([true]);
  });

  it('As a dotli user away from the window, I meet a browser whose permission request fails, the failure is counted and the toast stays in the page', async () => {
    // Given
    toasts.show();
    focused = false;
    installSystemAt('default', () => Promise.reject(new Error('Permission request failed')));
    const firstReport = new Promise<{ step: string; exception?: true }>(resolve => {
      onTestFinished(
        bindCaptureSink({
          exception: (_error, { step }) => {
            resolve({ step, exception: true });
          },
          expected: (_error, { step }) => {
            resolve({ step });
          },
        }),
      );
    });

    // When
    showNotification({ label: 'Ping', text: 'Kept' });
    const report = await firstReport;
    await timers.advance(NOTIFICATION_DISMISS_MS);

    // Then
    expect(report).toEqual({ step: 'system_notification' });
    expect(readLeaving()).toEqual([false]);
  });
});

/**
 * A system notification API whose permission stands at `permission`, recording what it shows and closes. Asking for
 * permission returns what `answer` returns.
 */
function installSystemAt(
  permission: NotificationPermission,
  answer: () => Promise<NotificationPermission> = () => Promise.resolve(permission),
): { title: string; body: string | undefined }[] {
  const created: { title: string; body: string | undefined }[] = [];
  class FakeNotification {
    static permission = permission;
    static requestPermission = vi.fn(answer);
    onclick: (() => void) | null = null;
    readonly title: string;
    constructor(title: string, options?: { body?: string }) {
      this.title = title;
      created.push({ title, body: options?.body });
    }
    close(): void {
      closed.push(this.title);
    }
  }
  // The fake carries only the members the notifier reads, not the whole Notification API.
  system = FakeNotification as unknown as SystemNotifications;
  return created;
}

function grantSystem(): { title: string; body: string | undefined }[] {
  return installSystemAt('granted');
}

function readLeaving(): boolean[] {
  return toasts.store.get().items.map(toast => toast.leaving);
}
