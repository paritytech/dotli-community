// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';

import { retireShellWorker, type RetireShellWorkerParams } from './retireShellWorker.js';

type Scope = RetireShellWorkerParams['scope'];

/** The type of a lifecycle event the worker listens to. */
type LifecycleType = Parameters<Scope['addEventListener']>[0];

/** A listener the worker adds to its scope. */
type Listener = Parameters<Scope['addEventListener']>[1];

/** A window client as the worker sees it. */
type FakeClient = Awaited<ReturnType<Scope['clients']['matchAll']>>[number];

type StartWorldParams = {
  /** Takes over from the old worker. Resolves by default. */
  skipWaiting?: () => Promise<void>;
  /** Unregisters the worker's registration. Resolves by default. */
  unregister?: () => Promise<boolean>;
  /** Lists the origin's cache names. Resolves with `cacheNames` by default. */
  keys?: () => Promise<string[]>;
  /** Deletes a cache. Resolves by default. */
  deleteCache?: (cacheName: string) => Promise<boolean>;
  /** Lists the window clients. Resolves with the fake tabs by default. */
  matchAll?: (options: { type: 'window' }) => Promise<readonly FakeClient[]>;
  /** Navigates the first tab. Resolves by default. */
  navigateFirst?: (url: string | URL) => Promise<WindowClient | null>;
  /** The origin's cache names. */
  cacheNames?: string[];
};

/** The activation calls the worker made: unregisters, deleted cache names and navigated URLs. */
type ActivationCalls = { unregister: number; delete: string[]; navigate: (string | URL)[] };

const PRECACHE = 'workbox-precache-v2-https://a.dot.li/';
const FIRST_TAB_URL = 'https://a.dot.li/';
const SECOND_TAB_URL = 'https://a.dot.li/browse';

/** Builds a worker scope, its tabs and its Cache Storage as plain fakes, and starts the worker over them. */
function startWorld({
  skipWaiting = () => Promise.resolve(),
  unregister = () => Promise.resolve(true),
  cacheNames = [PRECACHE],
  keys = () => Promise.resolve(cacheNames),
  deleteCache = () => Promise.resolve(true),
  navigateFirst = () => Promise.resolve(null),
  matchAll,
}: StartWorldParams = {}) {
  const listeners = new Map<LifecycleType, Listener>();
  const order: string[] = [];
  const first = {
    url: FIRST_TAB_URL,
    navigate: vi.fn((url: string | URL) => {
      order.push('navigate');
      return navigateFirst(url);
    }),
  };
  const second = {
    url: SECOND_TAB_URL,
    navigate: vi.fn((): Promise<WindowClient | null> => {
      order.push('navigate');
      return Promise.resolve(null);
    }),
  };
  const spies = {
    skipWaiting: vi.fn(skipWaiting),
    unregister: vi.fn(() => {
      order.push('unregister');
      return unregister();
    }),
    keys: vi.fn(keys),
    deleteCache: vi.fn(deleteCache),
    matchAll: vi.fn(matchAll ?? ((): Promise<readonly FakeClient[]> => Promise.resolve([first, second]))),
    logError: vi.fn(),
  };
  const params: RetireShellWorkerParams = {
    scope: {
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      skipWaiting: spies.skipWaiting,
      registration: { unregister: spies.unregister },
      clients: { matchAll: spies.matchAll },
    },
    caches: { keys: spies.keys, delete: spies.deleteCache },
    logError: spies.logError,
  };
  retireShellWorker(params);

  /** Dispatches a lifecycle event and resolves with the promise the worker handed to `waitUntil`. */
  function dispatch(type: LifecycleType): Promise<unknown> {
    const kept: Promise<unknown>[] = [];
    listeners.get(type)?.({
      waitUntil(promise) {
        kept.push(promise);
      },
    });
    return Promise.all(kept);
  }

  return { ...spies, first, second, order, listenedTypes: () => [...listeners.keys()], dispatch };
}

describe('retireShellWorker', () => {
  it("As a visitor with the old shell's worker, I get the new worker in control at once", async () => {
    // Given
    const world = startWorld();

    // When
    await world.dispatch('install');

    // Then
    expect(world.skipWaiting).toHaveBeenCalledOnce();
    expect(world.listenedTypes()).toEqual(['install', 'activate']);
  });

  it("As a visitor with the old shell's worker, I lose it, its precache and the old shell on activation", async () => {
    // Given
    const world = startWorld({ cacheNames: [PRECACHE, 'my-precache', 'other'] });

    // When
    await world.dispatch('activate');

    // Then
    expect(world.unregister).toHaveBeenCalledOnce();
    expect(world.order).toEqual(['unregister', 'navigate', 'navigate']);
    expect(world.deleteCache.mock.calls).toEqual([[PRECACHE]]);
    expect(world.matchAll.mock.calls).toEqual([[{ type: 'window' }]]);
    expect(world.first.navigate.mock.calls).toEqual([[FIRST_TAB_URL]]);
    expect(world.second.navigate.mock.calls).toEqual([[SECOND_TAB_URL]]);
    expect(world.logError).not.toHaveBeenCalled();
  });

  it('As a visitor whose browser fails to take over at once, I see it logged', async () => {
    // Given
    const failure = new Error('skipWaiting failed');
    const world = startWorld({ skipWaiting: () => Promise.reject(failure) });

    // When
    await world.dispatch('install');

    // Then
    expect(world.logError).toHaveBeenCalledOnce();
    expect(world.logError).toHaveBeenCalledWith(expect.any(String), failure);
  });

  it.each<[string, string, (failure: Error) => StartWorldParams, ActivationCalls]>([
    [
      'unregister the worker',
      'the precache and the old shell',
      failure => ({ unregister: () => Promise.reject(failure) }),
      { unregister: 1, delete: [PRECACHE], navigate: [FIRST_TAB_URL, SECOND_TAB_URL] },
    ],
    [
      'list its caches',
      'the worker and the old shell',
      failure => ({ keys: () => Promise.reject(failure) }),
      { unregister: 1, delete: [], navigate: [FIRST_TAB_URL, SECOND_TAB_URL] },
    ],
    [
      'delete the precache',
      'the worker and the old shell',
      failure => ({ deleteCache: () => Promise.reject(failure) }),
      { unregister: 1, delete: [PRECACHE], navigate: [FIRST_TAB_URL, SECOND_TAB_URL] },
    ],
    [
      'list its tabs',
      'the worker and the precache',
      failure => ({ matchAll: () => Promise.reject(failure) }),
      { unregister: 1, delete: [PRECACHE], navigate: [] },
    ],
  ])('As a visitor whose browser fails to %s, I still lose %s', async (step, _kept, fail, expected) => {
    // Given
    const failure = new Error(`${step} failed`);
    const world = startWorld(fail(failure));

    // When
    await world.dispatch('activate');

    // Then
    expect({
      unregister: world.unregister.mock.calls.length,
      delete: world.deleteCache.mock.calls.map(([cacheName]) => cacheName),
      navigate: [...world.first.navigate.mock.calls, ...world.second.navigate.mock.calls].map(([url]) => url),
    }).toEqual(expected);
    expect(world.logError).toHaveBeenCalledOnce();
    expect(world.logError).toHaveBeenCalledWith(expect.any(String), failure);
  });

  it('As a visitor with two old tabs, I get the second reloaded when the first fails to', async () => {
    // Given
    const world = startWorld({ navigateFirst: () => Promise.reject(new Error('navigate failed')) });

    // When
    await world.dispatch('activate');

    // Then
    expect(world.second.navigate.mock.calls).toEqual([[SECOND_TAB_URL]]);
    expect(world.logError).toHaveBeenCalledOnce();
  });
});
