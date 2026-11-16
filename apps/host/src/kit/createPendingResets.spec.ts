// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { catchError, createMemoryStorage } from '@dotli/shared/testing';
import { rethrow } from '../testing/rethrow.js';
import { createPendingResets } from './createPendingResets.js';

describe('pending resets', () => {
  it('As a user who resets everything, I get each origin purged on the next boot and not on later ones', () => {
    // Given
    const storage = createMemoryStorage();
    const beforeReload = createPendingResets({ storage: () => storage, onReadFailure: rethrow });
    const afterReload = createPendingResets({ storage: () => storage, onReadFailure: rethrow });

    // When
    beforeReload.schedule(['protocol', 'sandbox']);
    const nextBoot = [afterReload.take('protocol'), afterReload.take('sandbox')];
    const laterBoot = [afterReload.take('protocol'), afterReload.take('sandbox')];

    // Then
    expect({ nextBoot, laterBoot }).toEqual({ nextBoot: [true, true], laterBoot: [false, false] });
  });

  it('As a user recovering from a lost light client, I reload and only the protocol origin is purged', () => {
    // Given
    const storage = createMemoryStorage();
    const pending = createPendingResets({ storage: () => storage, onReadFailure: rethrow });

    // When
    pending.schedule(['protocol']);
    const purged = { sandbox: pending.take('sandbox'), protocol: pending.take('protocol') };

    // Then
    expect(purged).toEqual({ sandbox: false, protocol: true });
  });

  it('As a user without session storage, I reset and the purge fails loudly so the reset can report it', () => {
    // Given
    const refused = new DOMException('The operation is insecure.', 'SecurityError');
    const pending = createPendingResets({
      storage: () => {
        throw refused;
      },
      onReadFailure: rethrow,
    });

    // When
    const error = catchError(() => {
      pending.schedule(['protocol', 'sandbox']);
    });

    // Then
    expect(error).toEqual(expect.objectContaining({ message: 'Pending reset not scheduled', cause: refused }));
  });

  it('As a user without session storage, I boot with nothing purged and the refused read is reported', () => {
    // Given
    const refused = new DOMException('The operation is insecure.', 'SecurityError');
    const failures: unknown[] = [];
    const pending = createPendingResets({
      storage: () => {
        throw refused;
      },
      onReadFailure: error => failures.push(error),
    });

    // When
    const protocol = pending.take('protocol');

    // Then
    expect(protocol).toBe(false);
    expect(failures).toEqual([refused]);
  });
});
