// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sharedWorkerGeneration } from '../src/shared-worker-generation.js';

// Exclusive origin-scoped Web Locks, shared by every simulated tab.
function sharedLocks(): Pick<LockManager, 'request'> {
  const queues = new Map<string, Promise<unknown>>();
  const request = ((name: string, callback: (lock: Lock) => unknown) => {
    const next = (queues.get(name) ?? Promise.resolve()).then(() => callback({ name, mode: 'exclusive' }));
    queues.set(
      name,
      next.catch(() => undefined),
    );
    return next;
  }) as LockManager['request'];
  return { request };
}

const NETWORK = 'paseo-next-v2';

describe('shared protocol worker generations', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('navigator', { locks: sharedLocks() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('shares one replacement across concurrent tabs and ignores late fatals from an older generation', async () => {
    const [firstTab, secondTab] = await Promise.all([sharedWorkerGeneration(NETWORK), sharedWorkerGeneration(NETWORK)]);
    expect(secondTab).toBe(firstTab);

    const [firstReplacement, secondReplacement] = await Promise.all([
      sharedWorkerGeneration(NETWORK, firstTab),
      sharedWorkerGeneration(NETWORK, secondTab),
    ]);
    expect(firstReplacement).not.toBe(firstTab);
    expect(secondReplacement).toBe(firstReplacement);
    expect(await sharedWorkerGeneration(NETWORK)).toBe(firstReplacement);

    const next = await sharedWorkerGeneration(NETWORK, firstReplacement);
    expect(next).not.toBe(firstReplacement);
    expect(await sharedWorkerGeneration(NETWORK, firstTab)).toBe(next);
    expect(await sharedWorkerGeneration(NETWORK, secondReplacement)).toBe(next);
  });

  it('does not retire another network when one shared light client crashes', async () => {
    const otherNetwork = await sharedWorkerGeneration('previewnet');
    const failed = await sharedWorkerGeneration(NETWORK);
    await sharedWorkerGeneration(NETWORK, failed);

    expect(await sharedWorkerGeneration('previewnet')).toBe(otherNetwork);
  });

  it('surfaces a failed retirement rather than advertising an uncommitted replacement identity', async () => {
    const original = await sharedWorkerGeneration(NETWORK);
    vi.stubGlobal('localStorage', {
      getItem: localStorage.getItem.bind(localStorage),
      setItem: () => {
        throw new DOMException('Storage unavailable', 'SecurityError');
      },
    });

    await expect(sharedWorkerGeneration(NETWORK, original)).rejects.toMatchObject({ name: 'SecurityError' });
    expect(await sharedWorkerGeneration(NETWORK)).toBe(original);
  });
});
