// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { createListenerSet } from './createListenerSet.js';
import { waitForStatus } from './waitForStatus.js';

type Status = 'idle' | 'booting' | 'up' | 'down';

/** A status the test sets, with the `get` and `listen` a wait needs. */
function createStatus(initial: Status) {
  let current = initial;
  const changes = createListenerSet<Status>({
    onListenerError: error => {
      throw new Error('A wait listener threw', { cause: error });
    },
  });
  return {
    get: () => current,
    set(next: Status) {
      current = next;
      changes.emit(next);
    },
    listen: changes.subscribe,
  };
}

describe('waitForStatus', () => {
  it('As a layer above, I wait on the status there is now and settle without listening', async () => {
    // Given
    const cell = createStatus('up');
    let listened = 0;
    const counting = {
      get: cell.get,
      listen: (listener: (value: Status) => void) => {
        listened += 1;
        return cell.listen(listener);
      },
    };

    // When
    const wait = waitForStatus(counting, status => status === 'up');

    // Then
    await expect(wait).resolves.toBeUndefined();
    expect(listened).toBe(0);
  });

  it('As a layer above, I wait past the statuses my verdict leaves open and fail on the one it fails with', async () => {
    // Given
    const cell = createStatus('idle');
    const down = new Error('the layer went down');
    const heard: Status[] = [];
    const wait = waitForStatus(cell, status => {
      heard.push(status);
      return status === 'down' ? down : status === 'up';
    });

    // When
    cell.set('booting');
    cell.set('down');
    cell.set('up');

    // Then
    await expect(wait).rejects.toBe(down);
    expect(heard).toEqual(['idle', 'booting', 'down']);
  });

  it("As a layer above, I abort a pending wait and it fails with the signal's reason and hears no later status", async () => {
    // Given
    const cell = createStatus('idle');
    const controller = new AbortController();
    const lost = new Error('the layer was lost');
    let heard = 0;
    const wait = waitForStatus(
      cell,
      () => {
        heard += 1;
        return false;
      },
      { signal: controller.signal },
    );

    // When
    controller.abort(lost);
    cell.set('up');

    // Then
    await expect(wait).rejects.toBe(lost);
    expect(heard).toBe(1);
  });
});
