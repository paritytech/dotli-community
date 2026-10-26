// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { TrUApiProductProvider } from '@parity/truapi-host';
import { manualTimers } from '@dotli/shared/testing';
import { makeProvider } from '../page-core.fake.js';
import { createChanges } from '../../testing/changes.js';
import { CoreRestoringError, withCoreCalls, type SiteCallError } from './core-calls.js';

const REQUEST_TIMEOUT_MS = 1_000;
const RETRIES = 6;
const NOT_CONNECTED: SiteCallError = { tag: 'Domain', value: { tag: 'V1', value: { tag: 'NotConnected' } } };

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
  it('As a user whose core still restores its session, I see a call retried until it succeeds', async () => {
    // Given a call that is answered as restoring once, and a core connection
    const core = fakeCore();
    const timers = manualTimers();
    const changes = createChanges();
    let attempts = 0;
    const running = withCoreCalls({ acquire: core.acquire, timers }, REQUEST_TIMEOUT_MS, ({ restores, productId }) =>
      restores.call(() => {
        attempts += 1;
        changes.notify();
        if (attempts === 1) {
          throw new CoreRestoringError(NOT_CONNECTED);
        }
        return Promise.resolve(productId);
      }),
    );
    await changes.until(() => attempts === 1);

    // When the first retry delay passes
    await timers.advance(500);

    // Then the call ran again and succeeded
    await expect(running).resolves.toBe('dotli-product');
    expect(attempts).toBe(2);
  });

  it('As a user whose core never restores its session, I see the call fail after the last retry', async () => {
    // Given a call that is always answered as restoring
    const core = fakeCore();
    const timers = manualTimers();
    const changes = createChanges();
    let attempts = 0;
    const running = withCoreCalls({ acquire: core.acquire, timers }, REQUEST_TIMEOUT_MS, ({ restores }) =>
      restores.call(() => {
        attempts += 1;
        changes.notify();
        throw new CoreRestoringError(NOT_CONNECTED);
      }),
    ).catch((caught: unknown) => caught);
    await changes.until(() => attempts === 1);

    // When every retry delay passes, 500 ms doubling six times
    await timers.advance(31_500);

    // Then the first try and every retry were made and the last answer was rethrown
    const error = await running;
    expect(error).toBeInstanceOf(CoreRestoringError);
    expect(error).toMatchObject({ error: NOT_CONNECTED });
    expect(attempts).toBe(RETRIES + 1);
  });

  it('As a user, I leave no connection or core lease open after a call succeeds', async () => {
    // Given a core
    const core = fakeCore();

    // When a call succeeds
    await withCoreCalls({ acquire: core.acquire, timers: manualTimers() }, REQUEST_TIMEOUT_MS, () =>
      Promise.resolve(undefined),
    );

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
    const running = withCoreCalls({ acquire: core.acquire, timers: manualTimers() }, REQUEST_TIMEOUT_MS, () =>
      Promise.reject(failure),
    );

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
    const running = withCoreCalls({ acquire: core.acquire, timers: manualTimers() }, REQUEST_TIMEOUT_MS, () =>
      Promise.resolve(undefined),
    );

    // Then it fails with the refusal and the lease is released
    await expect(running).rejects.toBe(refused);
    expect(core.lease.release).toHaveBeenCalledTimes(1);
  });
});
