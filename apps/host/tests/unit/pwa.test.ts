// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface NotificationAction {
  label: string;
  onClick: () => void;
}

const workbox = vi.hoisted(() => ({
  listeners: new Map<string, ((event?: { wasWaitingBeforeRegister?: boolean }) => void)[]>(),
  messageSkipWaiting: vi.fn(),
}));
const notifications = vi.hoisted(() => ({ actions: [] as NotificationAction[] }));

vi.mock('workbox-window', () => ({
  Workbox: class {
    addEventListener(type: string, listener: (event?: { wasWaitingBeforeRegister?: boolean }) => void): void {
      workbox.listeners.set(type, [...(workbox.listeners.get(type) ?? []), listener]);
    }
    register(): Promise<undefined> {
      return Promise.resolve(undefined);
    }
    messageSkipWaiting(): void {
      workbox.messageSkipWaiting();
    }
  },
}));

vi.mock('@dotli/ui', () => ({
  showNotification: (params: { action?: NotificationAction }) => {
    if (params.action !== undefined) {
      notifications.actions.push(params.action);
    }
  },
}));

vi.mock('@dotli/metrics', () => ({ captureException: vi.fn(), recordExpected: vi.fn() }));
vi.mock('@dotli/shared', () => ({ markContinuation: vi.fn() }));

function emit(type: string, event?: { wasWaitingBeforeRegister?: boolean }): void {
  for (const listener of workbox.listeners.get(type) ?? []) {
    listener(event);
  }
}

/** The registration's waiting worker at the moment Reload is pressed. */
let waiting: object | null = null;
const reload = vi.fn();

beforeEach(async () => {
  vi.resetModules();
  workbox.listeners.clear();
  workbox.messageSkipWaiting.mockClear();
  notifications.actions = [];
  reload.mockClear();
  vi.stubGlobal('navigator', {
    serviceWorker: { getRegistration: () => Promise.resolve({ waiting }) },
  });
  vi.stubGlobal('location', { reload });
  await import('../../src/pwa.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function pressReload(): Promise<void> {
  emit('waiting', {});
  const action = notifications.actions.at(-1);
  expect(action?.label).toBe('Reload');
  action?.onClick();
  await vi.waitFor(() => {
    expect(reload.mock.calls.length + workbox.messageSkipWaiting.mock.calls.length).toBeGreaterThan(0);
  });
}

describe('the update available toast', () => {
  it('As a dotli user, Reload applies the waiting update and reloads once it is in control', async () => {
    // Given
    waiting = {};

    // When
    await pressReload();

    // Then
    expect(workbox.messageSkipWaiting).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();

    // When
    emit('controlling');

    // Then
    expect(reload).toHaveBeenCalledOnce();
  });

  it('As a dotli user with two tabs, Reload in the tab whose update another tab already applied reloads at once', async () => {
    // Given: the other tab's Reload activated the update, so nothing waits now
    waiting = null;

    // When
    await pressReload();

    // Then
    expect(reload).toHaveBeenCalledOnce();
    expect(workbox.messageSkipWaiting).not.toHaveBeenCalled();
  });
});

describe('an update that was already waiting when the page loaded', () => {
  it('As a dotli user, a plain reload applies the waiting update without asking', async () => {
    // Given
    waiting = {};

    // When
    emit('waiting', { wasWaitingBeforeRegister: true });

    // Then
    expect(notifications.actions).toHaveLength(0);
    await vi.waitFor(() => {
      expect(workbox.messageSkipWaiting).toHaveBeenCalledOnce();
    });
    expect(reload).not.toHaveBeenCalled();

    // When
    emit('controlling');

    // Then
    expect(reload).toHaveBeenCalledOnce();
  });
});
