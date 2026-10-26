// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindCaptureSink, type CaptureContext } from '@dotli/metrics';
import { FakePage } from '@dotli/shared/testing';
import { startPwa, type PwaDeps, type PwaRegistration, type PwaWorkbox, type PwaWorker } from './pwa.js';

type NotificationAction = NonNullable<Parameters<PwaDeps['showNotification']>[0]['action']>;

type Registration = {
  active: object | null;
  installing: PwaWorker | null;
  waiting: object | null;
} & PwaRegistration;

/** A new release's worker, which moves through `registration` as the browser would move it. */
function fakeWorker(registration: Registration, state: ServiceWorkerState) {
  const listeners: (() => void)[] = [];
  const worker = {
    state,
    addEventListener: (_type: 'statechange', listener: () => void) => {
      listeners.push(listener);
    },
  };
  const place = (): void => {
    registration.installing = worker.state === 'installing' ? worker : null;
    if (worker.state === 'installed') {
      registration.waiting = worker;
    }
    if (worker.state === 'activated') {
      registration.waiting = null;
      registration.active = worker;
    }
  };
  place();
  return {
    settle: (next: ServiceWorkerState): void => {
      worker.state = next;
      place();
      for (const listener of listeners.splice(0)) {
        listener();
      }
    },
  };
}

/** The shell's registration on a visit that already runs a worker. */
function fakeRegistration() {
  const found: (() => void)[] = [];
  const update = vi.fn(() => Promise.resolve());
  const registration: Registration = {
    active: {},
    installing: null,
    waiting: null,
    addEventListener: (_type: 'updatefound', listener: () => void) => {
      found.push(listener);
    },
    update,
  };
  return {
    registration,
    update,
    /** The browser found a new release, in `state`, downloading unless told otherwise. */
    find: (state: ServiceWorkerState = 'installing') => {
      const release = fakeWorker(registration, state);
      for (const listener of found) {
        listener();
      }
      return release;
    },
  };
}

/** A stand-in for Workbox that lets the test emit `controlling`. */
function fakeWorkbox(registration: PwaRegistration) {
  const controlling: (() => void)[] = [];
  const skipWaiting = vi.fn();
  const workbox: PwaWorkbox = {
    addEventListener: (_type: 'controlling', listener: () => void) => {
      controlling.push(listener);
    },
    messageSkipWaiting: skipWaiting,
    register: () => Promise.resolve(registration),
  };
  return {
    workbox,
    skipWaiting,
    takeControl: (): void => {
      for (const listener of controlling) {
        listener();
      }
    },
  };
}

/** A product host in production. Change its registration before awaiting, as the page found it on load. */
function start(overrides: Partial<PwaDeps> = {}) {
  const reg = fakeRegistration();
  const sw = fakeWorkbox(reg.registration);
  const page = new FakePage();
  const actions: NotificationAction[] = [];
  /** Settles once the page acted on the update, by reloading or by telling the worker to take over. */
  const applied = Promise.withResolvers<undefined>();
  const listening = Promise.withResolvers<undefined>();
  let tick: () => void = () => undefined;
  const reload = vi.fn(() => {
    applied.resolve(undefined);
  });
  sw.skipWaiting.mockImplementation(() => {
    applied.resolve(undefined);
  });
  const createWorkbox = vi.fn(() => Promise.resolve(sw.workbox));
  startPwa({
    production: true,
    label: 'browse',
    serviceWorkers: true,
    createWorkbox,
    showNotification: params => {
      if (params.action !== undefined) {
        actions.push(params.action);
      }
    },
    reload,
    page: {
      isOnline: () => page.window.onLine,
      visibility: page.document,
      every: (_ms, run) => {
        tick = run;
        listening.resolve(undefined);
      },
    },
    ...overrides,
  });
  return {
    ...sw,
    ...reg,
    page,
    actions,
    reload,
    createWorkbox,
    applied: applied.promise,
    /** Settles once the shell registered and listens for releases. */
    listening: listening.promise,
    /** The periodic check comes due. */
    tick: (): void => {
      tick();
    },
  };
}

/** As `start`, once the shell listens for releases. */
async function startListening() {
  const pwa = start();
  await pwa.listening;
  return pwa;
}

function pressReload(pwa: ReturnType<typeof start>): void {
  const action = pwa.actions.at(-1);
  expect(action?.label).toBe('Reload');
  action?.onClick();
}

describe('the update available toast', () => {
  it('As a dotli user, I am offered a new release the moment the browser finds it, before it has downloaded', async () => {
    // Given
    const pwa = await startListening();

    // When
    pwa.find();

    // Then
    expect(pwa.actions.map(action => action.label)).toEqual(['Reload']);
  });

  it('As a dotli user, I am offered a release the browser was already downloading when the page started', async () => {
    // Given
    const pwa = start();
    pwa.find();

    // When
    await pwa.listening;

    // Then
    expect(pwa.actions.map(action => action.label)).toEqual(['Reload']);
  });

  it('As a first-time visitor, I am offered nothing while the first worker installs', async () => {
    // Given
    const pwa = start();
    pwa.registration.active = null;
    await pwa.listening;

    // When
    pwa.find();

    // Then
    expect(pwa.actions).toEqual([]);
  });

  it('As a dotli user, Reload pressed while the release downloads applies it once downloaded, and reloads once it is in control', async () => {
    // Given
    const pwa = await startListening();
    const release = pwa.find();

    // When
    pressReload(pwa);

    // Then the page has not acted on it yet
    expect(pwa.skipWaiting).not.toHaveBeenCalled();
    expect(pwa.reload).not.toHaveBeenCalled();

    // When
    release.settle('installed');
    await pwa.applied;

    // Then
    expect(pwa.skipWaiting).toHaveBeenCalledOnce();
    expect(pwa.reload).not.toHaveBeenCalled();

    // When
    pwa.takeControl();

    // Then
    expect(pwa.reload).toHaveBeenCalledOnce();
  });

  it('As a dotli user, Reload pressed on a downloaded release applies it at once', async () => {
    // Given
    const pwa = await startListening();
    pwa.find().settle('installed');

    // When
    pressReload(pwa);
    await pwa.applied;

    // Then
    expect(pwa.skipWaiting).toHaveBeenCalledOnce();
  });

  it('As a dotli user whose release failed to download, Reload reloads onto the version I have', async () => {
    // Given
    const pwa = await startListening();
    const release = pwa.find();
    pressReload(pwa);

    // When
    release.settle('redundant');
    await pwa.applied;

    // Then
    expect(pwa.reload).toHaveBeenCalledOnce();
    expect(pwa.skipWaiting).not.toHaveBeenCalled();
  });

  it('As a dotli user with two tabs, Reload in the tab whose update another tab already applied reloads at once', async () => {
    // Given the other tab's Reload activated the update, so nothing waits now
    const pwa = await startListening();
    const release = pwa.find();
    release.settle('installed');
    release.settle('activated');

    // When
    pressReload(pwa);
    await pwa.applied;

    // Then
    expect(pwa.reload).toHaveBeenCalledOnce();
    expect(pwa.skipWaiting).not.toHaveBeenCalled();
  });
});

describe('checking for a new release', () => {
  it('As a dotli user, the shell asks for a new release as soon as it registers', async () => {
    // When
    const pwa = await startListening();

    // Then
    expect(pwa.update).toHaveBeenCalledOnce();
  });

  it('As a dotli user who comes back to the tab, the shell asks again, and on schedule while I stay', async () => {
    // Given
    const pwa = await startListening();

    // When
    pwa.page.setVisibility('hidden');
    pwa.page.setVisibility('visible');
    pwa.tick();

    // Then the check on registering, then the one each event earned
    expect(pwa.update).toHaveBeenCalledTimes(3);
  });

  it('As a dotli user offline, the shell sends no check that is bound to fail', async () => {
    // Given
    const pwa = await startListening();
    pwa.page.setOnline(false);

    // When
    pwa.page.setVisibility('visible');
    pwa.tick();

    // Then only the check on registering
    expect(pwa.update).toHaveBeenCalledOnce();
  });
});

describe('an update that was already waiting when the page loaded', () => {
  it('As a dotli user, a plain reload applies the waiting update without asking', async () => {
    // Given
    const pwa = start();
    pwa.find('installed');

    // When
    await pwa.applied;

    // Then
    expect(pwa.actions).toHaveLength(0);
    expect(pwa.skipWaiting).toHaveBeenCalledOnce();
    expect(pwa.reload).not.toHaveBeenCalled();

    // When
    pwa.takeControl();

    // Then
    expect(pwa.reload).toHaveBeenCalledOnce();
  });
});

describe('where the shell registers no service worker', () => {
  it('As a dotli developer, the dev server gets no worker that could serve stale modules', () => {
    // When
    const pwa = start({ production: false });

    // Then
    expect(pwa.createWorkbox).not.toHaveBeenCalled();
  });

  it('As a visitor of the bare host, its root stays the landing page because no worker answers it', () => {
    // When: the shell on the bare host, as /__preview serves it
    const pwa = start({ label: null });

    // Then
    expect(pwa.createWorkbox).not.toHaveBeenCalled();
  });

  it('As a visitor whose browser has no service workers, the shell registers none', () => {
    // When
    const pwa = start({ serviceWorkers: false });

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
    start({ createWorkbox: () => Promise.reject(new Error('Failed to fetch dynamically imported module')) });

    // Then
    await reported;
    expect(captured).toEqual([expect.objectContaining({ flow: 'pwa', step: 'sw_load' })]);
  });
});
