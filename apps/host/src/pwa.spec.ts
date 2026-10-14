// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindCaptureSink, type CaptureContext } from '@dotli/metrics';
import { startPwa, type PwaDeps, type PwaWorkbox } from './pwa.js';

type NotificationAction = NonNullable<Parameters<PwaDeps['showNotification']>[0]['action']>;
interface WaitingEvent {
  wasWaitingBeforeRegister?: boolean | undefined;
}

/** A stand-in for Workbox that lets the test emit its lifecycle events. */
function fakeWorkbox() {
  const listeners = new Map<string, ((event: WaitingEvent) => void)[]>();
  const skipWaiting = vi.fn();
  let markRegistered: () => void = () => undefined;
  const registered = new Promise<void>(resolve => {
    markRegistered = resolve;
  });
  const workbox: PwaWorkbox = {
    addEventListener: (type: string, listener: (event: WaitingEvent) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    messageSkipWaiting: skipWaiting,
    register: () => {
      markRegistered();
      return Promise.resolve(undefined);
    },
  };
  return {
    workbox,
    skipWaiting,
    /** Settles once the shell registered, by when it listens to every lifecycle event. */
    registered,
    emit: (type: string, event: WaitingEvent = {}): void => {
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
      }
    },
  };
}

/** A product host in production, whose registration has `waiting` as its waiting worker. */
function start(waiting: object | null, overrides: Partial<PwaDeps> = {}) {
  const sw = fakeWorkbox();
  const actions: NotificationAction[] = [];
  let markApplied: () => void = () => undefined;
  /** Settles once the page acted on the update, by reloading or by telling the worker to take over. */
  const applied = new Promise<void>(resolve => {
    markApplied = resolve;
  });
  const reload = vi.fn(markApplied);
  sw.skipWaiting.mockImplementation(markApplied);
  const createWorkbox = vi.fn(() => Promise.resolve(sw.workbox));
  startPwa({
    production: true,
    label: 'browse',
    serviceWorker: { getRegistration: () => Promise.resolve({ waiting } as ServiceWorkerRegistration) },
    createWorkbox,
    showNotification: params => {
      if (params.action !== undefined) {
        actions.push(params.action);
      }
    },
    reload,
    ...overrides,
  });
  return { ...sw, actions, reload, createWorkbox, applied };
}

/** As `start`, once the shell's worker is registered. */
async function startRegistered(waiting: object | null) {
  const pwa = start(waiting);
  await pwa.registered;
  return pwa;
}

async function pressReload(pwa: ReturnType<typeof start>): Promise<void> {
  pwa.emit('waiting');
  const action = pwa.actions.at(-1);
  expect(action?.label).toBe('Reload');
  action?.onClick();
  await pwa.applied;
}

describe('the update available toast', () => {
  it('As a dotli user, Reload applies the waiting update and reloads once it is in control', async () => {
    // Given
    const pwa = await startRegistered({});

    // When
    await pressReload(pwa);

    // Then
    expect(pwa.skipWaiting).toHaveBeenCalledOnce();
    expect(pwa.reload).not.toHaveBeenCalled();

    // When
    pwa.emit('controlling');

    // Then
    expect(pwa.reload).toHaveBeenCalledOnce();
  });

  it('As a dotli user with two tabs, Reload in the tab whose update another tab already applied reloads at once', async () => {
    // Given: the other tab's Reload activated the update, so nothing waits now
    const pwa = await startRegistered(null);

    // When
    await pressReload(pwa);

    // Then
    expect(pwa.reload).toHaveBeenCalledOnce();
    expect(pwa.skipWaiting).not.toHaveBeenCalled();
  });
});

describe('an update that was already waiting when the page loaded', () => {
  it('As a dotli user, a plain reload applies the waiting update without asking', async () => {
    // Given
    const pwa = await startRegistered({});

    // When
    pwa.emit('waiting', { wasWaitingBeforeRegister: true });

    // Then
    expect(pwa.actions).toHaveLength(0);
    await pwa.applied;
    expect(pwa.skipWaiting).toHaveBeenCalledOnce();
    expect(pwa.reload).not.toHaveBeenCalled();

    // When
    pwa.emit('controlling');

    // Then
    expect(pwa.reload).toHaveBeenCalledOnce();
  });
});

describe('where the shell registers no service worker', () => {
  it('As a dotli developer, the dev server gets no worker that could serve stale modules', () => {
    // When
    const pwa = start({}, { production: false });

    // Then
    expect(pwa.createWorkbox).not.toHaveBeenCalled();
  });

  it('As a visitor of the bare host, its root stays the landing page because no worker answers it', () => {
    // When: the shell on the bare host, as /__preview serves it
    const pwa = start({}, { label: null });

    // Then
    expect(pwa.createWorkbox).not.toHaveBeenCalled();
  });

  it('As a visitor whose browser has no service workers, the shell registers none', () => {
    // When
    const pwa = start({}, { serviceWorker: undefined });

    // Then
    expect(pwa.createWorkbox).not.toHaveBeenCalled();
  });
});

describe('the service worker code', () => {
  const captured: CaptureContext[] = [];
  let unbind: () => void = () => undefined;
  let reported: Promise<void> = Promise.resolve();

  beforeEach(() => {
    captured.length = 0;
    let markReported: () => void = () => undefined;
    reported = new Promise(resolve => {
      markReported = resolve;
    });
    unbind = bindCaptureSink({
      exception: (_err, ctx) => {
        captured.push(ctx);
        markReported();
      },
      expected: () => undefined,
    });
  });

  afterEach(() => {
    unbind();
  });

  it('As a dotli user whose connection drops before the worker code loads, the failure is reported', async () => {
    // When
    start({}, { createWorkbox: () => Promise.reject(new Error('Failed to fetch dynamically imported module')) });

    // Then
    await reported;
    expect(captured).toEqual([expect.objectContaining({ flow: 'pwa', step: 'sw_load' })]);
  });
});
