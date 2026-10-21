// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { createStatusCell, untilStatus } from './status-cell.js';

type Status = 'idle' | 'booting' | 'up' | 'down';

function recordingCell(initial: Status = 'idle') {
  const failures: { error: unknown; value: Status }[] = [];
  const cell = createStatusCell<Status>(initial, {
    onListenerError: (error, value) => {
      failures.push({ error, value });
    },
  });
  return { cell, failures };
}

describe('createStatusCell', () => {
  it('As a layer owner, setting the status it already has wakes nobody', () => {
    // Given
    const { cell } = recordingCell('up');
    const heard: Status[] = [];
    cell.subscribe(value => {
      heard.push(value);
    });

    // When
    cell.set('up');

    // Then
    expect(heard).toEqual([]);
  });
});

describe('untilStatus', () => {
  it('As a layer above, I settle a wait on the status there is now without subscribing', async () => {
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
    const wait = untilStatus(counting, status => status === 'up');

    // Then
    await expect(wait).resolves.toBeUndefined();
    expect(subscribed).toBe(0);
  });

  it('As a layer above, I wait past the statuses my verdict leaves open and fail on the one it fails with', async () => {
    // Given
    const { cell } = recordingCell('idle');
    const down = new Error('the layer went down');
    const heard: Status[] = [];
    const wait = untilStatus(cell, status => {
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

  it("As a layer above, I fail a wait with the signal's reason when it aborts first, and stop hearing the status", async () => {
    // Given
    const { cell } = recordingCell('idle');
    const controller = new AbortController();
    const lost = new Error('the layer was lost');
    let heard = 0;
    const wait = untilStatus(
      cell,
      () => {
        heard += 1;
        return false;
      },
      controller.signal,
    );

    // When
    controller.abort(lost);
    cell.set('up');

    // Then
    await expect(wait).rejects.toBe(lost);
    expect(heard).toBe(1);
  });

  it("As a layer above, I fail a wait on a signal that aborted before it began with the signal's reason", async () => {
    // Given
    const { cell } = recordingCell('up');
    const lost = new Error('the layer was lost');

    // When
    const wait = untilStatus(cell, () => true, AbortSignal.abort(lost));

    // Then
    await expect(wait).rejects.toBe(lost);
  });
});
