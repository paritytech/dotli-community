// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { recordReports } from '@dotli/metrics/testing';
import {
  createFakePage,
  createManualTimers,
  resetAllStoresForTests,
  type FakePage,
  type ManualTimers,
} from '@dotli/shared/testing';
import { createToasts } from '../page/state/createToasts.js';
import { createNotifier, type SystemNotifications } from './createNotifier.js';

/** How long a toast stays when nothing keeps it. */
const DEFAULT_DISMISS_MS = 10_000;

let page: FakePage;
let timers: ManualTimers;
let toasts: ReturnType<typeof createToasts>;
let system: SystemNotifications | undefined;
let closed: string[];
let shown: { onclick: (() => void) | null }[];
let pageCalls: string[];
let looking: boolean;
let showNotification: ReturnType<typeof createNotifier>;

beforeEach(() => {
  page = createFakePage();
  timers = createManualTimers();
  toasts = createToasts({ page: page.document, timers });
  system = undefined;
  closed = [];
  shown = [];
  pageCalls = [];
  looking = true;
  // The notifier over this toast stack, on a page the test says the user is looking at or not.
  showNotification = createNotifier({
    toasts,
    attended: () => looking,
    system: () => system,
    page: {
      focus() {
        pageCalls.push('focus');
      },
      open(url) {
        pageCalls.push(`open ${String(url)}`);
        return null;
      },
    },
    timers,
  });
});

afterEach(() => {
  resetAllStoresForTests();
});

describe('showNotification', () => {
  it('As a dotli user, I get a notification and see its title and trimmed text', () => {
    // When
    showNotification({ label: 'Hello', text: '  World  ' });

    // Then
    const [toast] = toasts.store.get().items;
    expect(toast?.label).toBe('Hello');
    expect(toast?.text).toBe('World');
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

  it('As a dotli user away from the page, I get a system notification when permission is granted, and none for one that opts out', () => {
    // Given
    const created = grantSystem();
    looking = false;

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
    looking = false;
    showNotification({ label: 'Ping', text: 'Closing' });

    // When
    await timers.advance(4999);
    const closedBefore = [...closed];
    await timers.advance(1);

    // Then
    expect(closedBefore).toEqual([]);
    expect(closed).toEqual(['Ping']);
  });

  it('As a dotli user away from the window, I click a system notification and the page comes forward and opens its link', () => {
    // Given
    grantSystem();
    looking = false;
    showNotification({ label: 'Ping', text: 'Open me', deeplink: 'https://example.com/item' });

    // When
    shown[0]?.onclick?.();

    // Then
    expect(pageCalls).toEqual(['focus', 'open https://example.com/item']);
  });

  it('As a dotli user away from the window with system notifications blocked, I get a notification and find it still in the page', async () => {
    // Given
    toasts.show();
    installSystemAt('denied');
    looking = false;

    // When
    showNotification({ label: 'Ping', text: 'Kept' });
    await timers.advance(DEFAULT_DISMISS_MS);

    // Then
    expect(readLeaving()).toEqual([false]);
  });

  it('As a dotli user away from the window on a browser that grants system notifications but cannot build one, I get a notification and find it still in the page, and the failure is reported', async () => {
    // Given
    const reports = recordReports({ onFinished: onTestFinished });
    toasts.show();
    looking = false;
    // Chrome on Android grants the permission but builds a notification only through a service worker.
    function buildIllegally(): never {
      throw new TypeError('Illegal constructor');
    }
    // The fake carries only the members the notifier reads, not the whole Notification API.
    system = Object.assign(buildIllegally, { permission: 'granted' }) as unknown as SystemNotifications;

    // When
    showNotification({ label: 'Ping', text: 'Kept' });
    await timers.advance(DEFAULT_DISMISS_MS);

    // Then
    expect(readLeaving()).toEqual([false]);
    expect(reports.expected).toMatchObject([{ step: 'system_notification' }]);
  });

  it('As a dotli user away from the window, I get a notification the system showed and it leaves the page after the default delay', async () => {
    // Given
    toasts.show();
    grantSystem();
    looking = false;

    // When
    showNotification({ label: 'Ping', text: 'Shown' });
    await timers.advance(DEFAULT_DISMISS_MS);

    // Then
    expect(readLeaving()).toEqual([true]);
  });
});

/**
 * A system notification API whose permission stands at `permission`, recording what it shows and closes.
 */
function installSystemAt(permission: NotificationPermission): { title: string; body: string | undefined }[] {
  const created: { title: string; body: string | undefined }[] = [];
  class FakeNotification {
    static permission = permission;
    onclick: (() => void) | null = null;
    readonly title: string;
    constructor(title: string, options?: { body?: string }) {
      this.title = title;
      created.push({ title, body: options?.body });
      shown.push(this);
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
