// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { withCoreCalls } from './withCoreCalls.js';
import { createFakeCoreLease } from './withCoreCalls.fake.js';

const REQUEST_TIMEOUT_MS = 1_000;

describe('core calls', () => {
  it('As a user, I let a call succeed and no connection or core lease is left open', async () => {
    // Given a core
    const core = createFakeCoreLease();

    // When a call succeeds
    await withCoreCalls({ acquire: core.acquire, requestTimeoutMs: REQUEST_TIMEOUT_MS }, () =>
      Promise.resolve(undefined),
    );

    // Then the one connection was closed and the one lease released
    expect(core.lease.connect).toHaveBeenCalledTimes(1);
    expect(core.connection.close).toHaveBeenCalledTimes(1);
    expect(core.lease.release).toHaveBeenCalledTimes(1);
  });

  it('As a user, I see a call fail and no connection or core lease is left open', async () => {
    // Given a core
    const core = createFakeCoreLease();
    const failure = new Error('failed');

    // When a call fails
    const running = withCoreCalls({ acquire: core.acquire, requestTimeoutMs: REQUEST_TIMEOUT_MS }, () =>
      Promise.reject(failure),
    );

    // Then it fails with that error, and the connection is closed and the lease released
    await expect(running).rejects.toBe(failure);
    expect(core.connection.close).toHaveBeenCalledTimes(1);
    expect(core.lease.release).toHaveBeenCalledTimes(1);
  });

  it('As a user, I run a call the core refuses a connection for and no core lease is left open', async () => {
    // Given a core that refuses the connection
    const core = createFakeCoreLease();
    const refused = new Error('refused');
    core.lease.connect.mockRejectedValueOnce(refused);

    // When a call is run
    const running = withCoreCalls({ acquire: core.acquire, requestTimeoutMs: REQUEST_TIMEOUT_MS }, () =>
      Promise.resolve(undefined),
    );

    // Then it fails with the refusal and the lease is released
    await expect(running).rejects.toBe(refused);
    expect(core.lease.release).toHaveBeenCalledTimes(1);
  });
});
