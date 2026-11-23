// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createManualTimers, createMemoryStorage } from '@dotli/shared/testing';
import type { SafeStorage } from '@dotli/shared';
import type { Continuation } from './createContinuation.js';
import { createUpdateReload } from './createUpdateReload.js';
import { createBlockedStorage } from '../testing/createBlockedStorage.js';

describe('createUpdateReload', () => {
  it('As a user whose tab meets an update twice on one build, I start a reload each time and only the first claim holds and shows the screen', () => {
    // Given
    const { updateReload, countShown } = setupUpdateReload({ store: createMemoryStorage() });

    // When
    const claims = [updateReload.start(), updateReload.start()];

    // Then
    expect({ claims, shown: countShown() }).toEqual({ claims: [true, false], shown: 1 });
  });

  it('As a user whose tab reloaded for an update on an older build, I meet an update on a newer build and my claim holds', () => {
    // Given
    const store = createMemoryStorage({ entries: { 'dotli:update-reload': 'build-a' } });
    const { updateReload } = setupUpdateReload({ store });

    // When
    const claimed = updateReload.start();

    // Then
    expect(claimed).toBe(true);
  });

  it('As a user whose tab has no sessionStorage, I meet an update and my claim does not hold, so nothing shows and the page never reloads', async () => {
    // Given
    const { updateReload, timers, countShown, reloads } = setupUpdateReload({ store: createBlockedStorage() });

    // When
    const claimed = updateReload.start();
    await timers.advance(1_000);

    // Then
    expect({ claimed, shown: countShown(), reloads }).toEqual({ claimed: false, shown: 0, reloads: [] });
  });

  it('As a user whose page reloads for an update, I have about a second to read why before the page reloads as an update', async () => {
    // Given
    const { updateReload, timers, reloads } = setupUpdateReload({ store: createMemoryStorage() });

    // When
    updateReload.start();
    await timers.advance(999);
    const beforeTheSecond = [...reloads];
    await timers.advance(1);

    // Then
    expect({ beforeTheSecond, reloads }).toEqual({ beforeTheSecond: [], reloads: ['app_update'] });
  });
});

/** Builds the update reload of build `build-b` over `store`, with the screens it shows and the reloads it asks for counted. */
function setupUpdateReload({ store }: { store: Pick<SafeStorage, 'getItem' | 'setItem'> }) {
  const timers = createManualTimers();
  const reloads: Continuation[] = [];
  let shown = 0;
  const updateReload = createUpdateReload({
    store,
    build: 'build-b',
    timers,
    show() {
      shown += 1;
    },
    reload: reason => reloads.push(reason),
  });
  return { updateReload, timers, reloads, countShown: () => shown };
}
