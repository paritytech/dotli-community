// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createRuntimeLoader } from './runtime-loader.js';

const RUNTIME = { name: 'host runtime' };

describe('runtime loader', () => {
  it('As a user whose first chunk load failed, I press Retry and the chunk loads again', async () => {
    // Given: a load that fails once, then succeeds
    const failure = new Error('chunk fetch failed');
    const load = vi.fn<() => Promise<typeof RUNTIME>>().mockRejectedValueOnce(failure).mockResolvedValue(RUNTIME);
    const loadRuntime = createRuntimeLoader(load);
    await expect(loadRuntime()).rejects.toBe(failure);

    // When: the next caller asks for it
    const runtime = await loadRuntime();

    // Then: it loaded a second time instead of handing back the cached failure
    expect(runtime).toBe(RUNTIME);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('As a core booting while the product frame mounts, I share its load and the runtime loads once', async () => {
    // Given
    const load = vi.fn<() => Promise<typeof RUNTIME>>().mockResolvedValue(RUNTIME);
    const loadRuntime = createRuntimeLoader(load);

    // When: two callers overlap, and a third comes later
    const [frame, core] = await Promise.all([loadRuntime(), loadRuntime()]);
    const later = await loadRuntime();

    // Then
    expect([frame, core, later]).toEqual([RUNTIME, RUNTIME, RUNTIME]);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
