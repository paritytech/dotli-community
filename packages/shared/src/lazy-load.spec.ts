// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createLazyLoad } from './lazy-load.js';
import { deferred } from './testing/deferred.js';

const RUNTIME = { name: 'host runtime' };

describe('createLazyLoad', () => {
  it('As a core booting while the product frame mounts, I share its load and the chunk loads once', async () => {
    // Given
    const load = vi.fn<() => Promise<typeof RUNTIME>>().mockResolvedValue(RUNTIME);
    const loadRuntime = createLazyLoad(load);

    // When two callers overlap, and a third comes later
    const [frame, core] = await Promise.all([loadRuntime(), loadRuntime()]);
    const later = await loadRuntime();

    // Then
    expect([frame, core, later]).toEqual([RUNTIME, RUNTIME, RUNTIME]);
    expect(load).toHaveBeenCalledOnce();
  });

  it('As a user whose first chunk load failed, I press Retry and the chunk loads again', async () => {
    // Given a load that fails once, then succeeds
    const failure = new Error('chunk fetch failed');
    const load = vi.fn<() => Promise<typeof RUNTIME>>().mockRejectedValueOnce(failure).mockResolvedValue(RUNTIME);
    const loadRuntime = createLazyLoad(load);
    await expect(loadRuntime()).rejects.toBe(failure);

    // When the next caller asks for it
    const runtime = await loadRuntime();

    // Then it loaded a second time instead of handing back the kept failure
    expect(runtime).toBe(RUNTIME);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('As a caller queued behind a load that fails, I load again myself and get the chunk', async () => {
    // Given a first load still in flight, and a second caller waiting behind it
    const first = deferred<typeof RUNTIME>();
    const failure = new Error('chunk fetch failed');
    const load = vi.fn<() => Promise<typeof RUNTIME>>().mockReturnValueOnce(first.promise).mockResolvedValue(RUNTIME);
    const loadRuntime = createLazyLoad(load);
    const failed = loadRuntime();
    const queued = loadRuntime();

    // When the first load fails
    first.reject(failure);

    // Then only the first caller sees the failure, and the queued one loaded the chunk itself
    await expect(failed).rejects.toBe(failure);
    await expect(queued).resolves.toBe(RUNTIME);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('As a page whose chunk keeps failing, I hear of the first miss only', async () => {
    // Given a load that always fails
    const failure = new Error('chunk missing');
    const onFirstMiss = vi.fn<(err: unknown) => void>();
    const loadRuntime = createLazyLoad(() => Promise.reject(failure), { onFirstMiss });

    // When two callers try it in turn
    await expect(loadRuntime()).rejects.toBe(failure);
    await expect(loadRuntime()).rejects.toBe(failure);

    // Then
    expect(onFirstMiss).toHaveBeenCalledOnce();
    expect(onFirstMiss).toHaveBeenCalledWith(failure);
  });

  it('As a caller, I get a kept empty value without the load running again', async () => {
    // Given a load that finds nothing
    const load = vi.fn<() => Promise<null>>().mockResolvedValue(null);
    const loadNothing = createLazyLoad(load);
    await loadNothing();

    // When another caller asks
    const again = await loadNothing();

    // Then the empty value is kept like any other
    expect(again).toBeNull();
    expect(load).toHaveBeenCalledOnce();
  });
});
