// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import 'fake-indexeddb/auto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { NotificationRecord } from '@dotli/storage/notification-activations';
import {
  acknowledgeNotificationActivation,
  activateNotification,
  cancelNotificationActivation,
  findNotification,
  pendingNotificationActivations,
  retainNotification,
} from '@dotli/storage/notification-activations';

const origin = 'https://host.example';
let click: (event: NotificationEvent) => void;
const windows: WindowClient[] = [];
const matchAll = vi.fn(() => Promise.resolve(windows));
const openWindow = vi.fn<(url: string) => Promise<WindowClient | null>>().mockResolvedValue(null);

interface TestWindowClient {
  url: string;
  focused: boolean;
  frameType: FrameType;
  postMessage: Mock;
  focus: Mock<() => Promise<WindowClient>>;
}

interface TestNotificationClick {
  notification: { data: unknown; close: Mock };
  waitUntil: Mock<(promise: Promise<unknown>) => void>;
  preventDefault: Mock;
  stopImmediatePropagation: Mock;
}

function windowClient(url: string, focused = false, frameType: FrameType = 'top-level'): TestWindowClient {
  const postMessage = vi.fn();
  const client = { url, focused, frameType, postMessage, focus: vi.fn<() => Promise<WindowClient>>() };
  client.focus.mockResolvedValue(client as unknown as WindowClient);
  return client;
}

async function retain(
  entryUrl = `${origin}/?product=notes`,
  expiresAt = Date.now() + 60_000,
): Promise<NotificationRecord> {
  return retainNotification({
    scope: { product: crypto.randomUUID(), account: 'alice', network: 'paseo', artifact: 'cid' },
    notificationId: 1,
    entryUrl,
    route: '/messages/42',
    expiresAt,
  });
}

async function dispatch(data: unknown): Promise<TestNotificationClick> {
  const pending: Promise<unknown>[] = [];
  const event = {
    notification: { data, close: vi.fn() },
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      pending.push(promise);
    }),
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
  };
  click(event as unknown as NotificationEvent);
  await Promise.all(pending);
  return event;
}

beforeAll(async () => {
  vi.stubGlobal('self', {
    location: { origin },
    clients: { matchAll, openWindow },
    addEventListener: (type: string, listener: (event: NotificationEvent) => void) => {
      if (type === 'notificationclick') {
        click = listener;
      }
    },
  });
  // This entry registers on import, so the test worker global must exist first.
  await import('./notification-worker.js');
});

beforeEach(() => {
  windows.length = 0;
  vi.clearAllMocks();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('ordinary notification service worker activation', () => {
  it('commits durable activation before focusing the preferred host without an unused wake message', async () => {
    const record = await retain();
    const otherHost = windowClient(`${origin}/`);
    const focusedHost = windowClient(`${origin}/?product=other`, true);
    windows.push(otherHost as unknown as WindowClient, focusedHost as unknown as WindowClient);
    focusedHost.focus.mockImplementation(async () => {
      expect((await findNotification(record.scope.product, record.notificationId))?.activated).toBe(true);
      return focusedHost as unknown as WindowClient;
    });

    const event = await dispatch({ dotliActivation: record.token });

    expect(event.notification.close).toHaveBeenCalledOnce();
    expect(event.waitUntil).toHaveBeenCalledOnce();
    expect(matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
    expect(otherHost.focus).not.toHaveBeenCalled();
    expect(focusedHost.focus).toHaveBeenCalledOnce();
    expect(focusedHost.postMessage).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
    expect(await pendingNotificationActivations(record.scope)).toEqual([{ ...record, activated: true }]);
    expect(await pendingNotificationActivations({ ...record.scope, account: 'bob' })).toEqual([]);
  });

  it('opens only the durable host entry when no same-origin top-level host exists', async () => {
    const record = await retain();
    const foreign = windowClient('https://product.example/', true);
    const nested = windowClient(`${origin}/`, true, 'nested');
    windows.push(foreign as unknown as WindowClient, nested as unknown as WindowClient);
    openWindow.mockImplementationOnce(async url => {
      expect((await findNotification(record.scope.product, record.notificationId))?.activated).toBe(true);
      expect(url).toBe(record.entryUrl);
      return null;
    });

    await dispatch({ dotliActivation: record.token });

    expect(openWindow).toHaveBeenCalledExactlyOnceWith(record.entryUrl);
    expect(foreign.focus).not.toHaveBeenCalled();
    expect(nested.focus).not.toHaveBeenCalled();
    // A new module instance simulates a reloaded page; the event is not in memory.
    vi.resetModules();
    const reloaded = await import('@dotli/storage/notification-activations');
    expect(await reloaded.pendingNotificationActivations(record.scope)).toEqual([{ ...record, activated: true }]);
  });

  it.each([
    'https://attacker.example/',
    'http://host.example/',
    'https://user:password@host.example/',
    'javascript:alert(1)',
    'data:text/html,hello',
    'not a URL',
  ])('does not focus or navigate for an invalid durable entry %s', async entryUrl => {
    const record = await retain(entryUrl);
    windows.push(windowClient(`${origin}/`, true) as unknown as WindowClient);

    await dispatch({ dotliActivation: record.token });

    expect(matchAll).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it.each(['expired', 'cancelled', 'acknowledged', 'unknown'] as const)(
    'does not wake a host for a %s activation',
    async state => {
      const record = await retain(undefined, state === 'expired' ? Date.now() - 1 : undefined);
      if (state === 'cancelled') {
        await cancelNotificationActivation(record.scope.product, record.notificationId);
      }
      if (state === 'acknowledged') {
        await activateNotification(record.token);
        await acknowledgeNotificationActivation(record.scope, record.sequence);
      }

      await dispatch({ dotliActivation: state === 'unknown' ? crypto.randomUUID() : record.token });

      expect(matchAll).not.toHaveBeenCalled();
      expect(openWindow).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    undefined,
    'token',
    {},
    { receiving: 'another-handler' },
    { dotliActivation: 42 },
    { dotliActivation: '' },
    { dotliActivation: { route: '/messages' } },
    { dotliActivation: 'token', entryUrl: 'https://attacker.example/' },
    { dotliActivation: 'token', route: '/messages' },
  ])('leaves unrelated or malformed notification data untouched: %j', async data => {
    const event = await dispatch(data);

    expect(event.notification.close).not.toHaveBeenCalled();
    expect(event.waitUntil).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(matchAll).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });
});
