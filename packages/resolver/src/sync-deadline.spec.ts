// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { raceSyncTimeout } from './sync-deadline.js';

const CAP_MS = 180_000;

describe('raceSyncTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('As a caller whose chain never syncs, I get a typed sync-timeout rejection', async () => {
    // Given
    const never = new Promise<string>(() => {
      /* never settles, like whenReady() with no reachable peers */
    });

    // When
    const raced = raceSyncTimeout(never, 'Asset Hub Paseo', 5_000);
    const assertion = expect(raced).rejects.toMatchObject({
      name: 'NetworkSyncTimeoutError',
      chain: 'Asset Hub Paseo',
      timeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);

    // Then
    await assertion;
  });

  it("As a caller whose chain syncs in time, I get the work's value", async () => {
    // Given
    const work = Promise.resolve('synced');

    // When
    const result = await raceSyncTimeout(work, 'Asset Hub Paseo', 5_000);

    // Then
    expect(result).toBe('synced');
  });

  it('As a caller whose work settles first, I leave no timer running', async () => {
    // Given
    const work = Promise.resolve('synced');

    // When
    await raceSyncTimeout(work, 'Asset Hub Paseo', CAP_MS);

    // Then
    expect(vi.getTimerCount()).toBe(0);
  });

  it('As a caller whose work rejects first, I leave no timer running', async () => {
    // Given
    const work = Promise.reject(new Error('provider died'));

    // When
    await expect(raceSyncTimeout(work, 'Asset Hub Paseo', CAP_MS)).rejects.toThrow('provider died');

    // Then
    expect(vi.getTimerCount()).toBe(0);
  });

  it('As two callers sharing one sync, I see the tighter budget fail and leave the looser one alive', async () => {
    // Given one sync two callers wait on
    let settleShared: (value: string) => void = () => undefined;
    const shared = new Promise<string>(resolve => {
      settleShared = resolve;
    });

    // When the tighter budget runs out before the sync settles
    const impatient = raceSyncTimeout(shared, 'Asset Hub Paseo', 20);
    const patient = raceSyncTimeout(shared, 'Asset Hub Paseo', 5_000);
    const rejection = expect(impatient).rejects.toMatchObject({
      name: 'NetworkSyncTimeoutError',
    });
    await vi.advanceTimersByTimeAsync(20);
    await rejection;
    settleShared('synced');

    // Then
    await expect(patient).resolves.toBe('synced');
  });
});
