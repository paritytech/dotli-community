// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { createStatusCell } from './createStatusCell.js';
import { waitForStatus } from './waitForStatus.js';

type Status = 'idle' | 'booting' | 'up' | 'down';

function recordingCell(initial: Status = 'idle') {
  const failures: { error: unknown; value: Status }[] = [];
  const cell = createStatusCell<Status>({
    initial,
    onListenerError: (error, value) => {
      failures.push({ error, value });
    },
  });
  return { cell, failures };
}

describe('waitForStatus', () => {
  it('As a layer above, I wait on the status there is now and settle without subscribing', async () => {
    // Given
    const { cell } = recordingCell('up');
    let subscribed = 0;
    const counting = {
      get: cell.get,
      subscribe: (listener: (value: Status) => void) => {
        subscribed += 1;
        return cell.subscribe(listener);
      },
    };

    // When
    const wait = waitForStatus(counting, status => status === 'up');

    // Then
    await expect(wait).resolves.toBeUndefined();
    expect(subscribed).toBe(0);
  });

  it('As a layer above, I wait past the statuses my verdict leaves open and fail on the one it fails with', async () => {
    // Given
    const { cell } = recordingCell('idle');
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
    const { cell } = recordingCell('idle');
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

  it("As a layer above, I wait with a signal that aborted already and fail with the signal's reason", async () => {
    // Given
    const { cell } = recordingCell('up');
    const lost = new Error('the layer was lost');

    // When
    const wait = waitForStatus(cell, () => true, { signal: AbortSignal.abort(lost) });

    // Then
    await expect(wait).rejects.toBe(lost);
  });
});
