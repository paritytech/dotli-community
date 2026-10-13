// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { memoryStorage } from '@dotli/shared/testing';
import { createPendingResets } from './pending-reset.js';

/** For a storage that works, where a read failure would be a bug in the test. */
function rethrow(err: unknown): never {
  throw err;
}

describe('pending resets', () => {
  it('As a user who resets everything, I get each origin purged on the next boot and not on later ones', () => {
    // Given
    const storage = memoryStorage();
    const beforeReload = createPendingResets(() => storage, rethrow);
    const afterReload = createPendingResets(() => storage, rethrow);

    // When
    beforeReload.schedule(['protocol', 'sandbox']);

    // Then
    expect(afterReload.take('protocol')).toBe(true);
    expect(afterReload.take('sandbox')).toBe(true);
    expect(afterReload.take('protocol')).toBe(false);
    expect(afterReload.take('sandbox')).toBe(false);
  });

  it('As a user recovering from a lost light client, I reload with only the protocol origin purged', () => {
    // Given
    const storage = memoryStorage();
    const pending = createPendingResets(() => storage, rethrow);

    // When
    pending.schedule(['protocol']);

    // Then
    expect(pending.take('sandbox')).toBe(false);
    expect(pending.take('protocol')).toBe(true);
  });

  it('As a user without session storage, scheduling a purge fails loudly so the reset can report it', () => {
    // Given
    const refused = new DOMException('The operation is insecure.', 'SecurityError');
    const pending = createPendingResets(() => {
      throw refused;
    }, rethrow);

    // When
    const schedule = (): void => {
      pending.schedule(['protocol', 'sandbox']);
    };

    // Then
    expect(schedule).toThrow(expect.objectContaining({ message: 'Pending reset not scheduled', cause: refused }));
  });

  it('As a user without session storage, I boot with nothing purged and the refused read is reported', () => {
    // Given
    const refused = new DOMException('The operation is insecure.', 'SecurityError');
    const failures: unknown[] = [];
    const pending = createPendingResets(
      () => {
        throw refused;
      },
      err => failures.push(err),
    );

    // When
    const protocol = pending.take('protocol');

    // Then
    expect(protocol).toBe(false);
    expect(failures).toEqual([refused]);
  });
});
