// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { TrUApiProductProvider } from '@parity/truapi-host';
import { makeProvider } from '../page-core.fake.js';
import { withCoreCalls } from './core-calls.js';

const REQUEST_TIMEOUT_MS = 1_000;

function fakeCore() {
  const connection = {
    provider: makeProvider() as unknown as TrUApiProductProvider,
    productId: 'dotli-product',
    close: vi.fn(),
  };
  const lease = { connect: vi.fn(() => Promise.resolve(connection)), release: vi.fn() };
  const acquire = vi.fn(() => Promise.resolve(lease));
  return { acquire, lease, connection };
}

describe('core calls', () => {
  it('As a user, I leave no connection or core lease open after a call succeeds', async () => {
    // Given a core
    const core = fakeCore();

    // When a call succeeds
    await withCoreCalls({ acquire: core.acquire }, REQUEST_TIMEOUT_MS, () => Promise.resolve(undefined));

    // Then the one connection was closed and the one lease released
    expect(core.lease.connect).toHaveBeenCalledTimes(1);
    expect(core.connection.close).toHaveBeenCalledTimes(1);
    expect(core.lease.release).toHaveBeenCalledTimes(1);
  });

  it('As a user, I leave no connection or core lease open after a call fails', async () => {
    // Given a core
    const core = fakeCore();
    const failure = new Error('failed');

    // When a call fails
    const running = withCoreCalls({ acquire: core.acquire }, REQUEST_TIMEOUT_MS, () => Promise.reject(failure));

    // Then it fails with that error, and the connection is closed and the lease released
    await expect(running).rejects.toBe(failure);
    expect(core.connection.close).toHaveBeenCalledTimes(1);
    expect(core.lease.release).toHaveBeenCalledTimes(1);
  });

  it('As a user, I leave no core lease open when the core refuses a connection', async () => {
    // Given a core that refuses the connection
    const core = fakeCore();
    const refused = new Error('refused');
    core.lease.connect.mockRejectedValueOnce(refused);

    // When a call is run
    const running = withCoreCalls({ acquire: core.acquire }, REQUEST_TIMEOUT_MS, () => Promise.resolve(undefined));

    // Then it fails with the refusal and the lease is released
    await expect(running).rejects.toBe(refused);
    expect(core.lease.release).toHaveBeenCalledTimes(1);
  });
});
