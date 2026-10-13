// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { createStatusCell } from './status-cell.js';

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
  it('As a layer owner, a status change a listener makes reaches every listener after the change in progress, in order', () => {
    // Given a first listener that moves the status on from `booting`, and a second that records
    const { cell } = recordingCell();
    const heard: string[] = [];
    cell.subscribe(value => {
      heard.push(`first:${value}`);
      if (value === 'booting') {
        cell.set('up');
      }
    });
    cell.subscribe(value => {
      heard.push(`second:${value}`);
    });

    // When
    cell.set('booting');

    // Then both hear `booting` before either hears `up`
    expect(heard).toEqual(['first:booting', 'second:booting', 'first:up', 'second:up']);
    expect(cell.get()).toBe('up');
  });

  it('As a layer owner, a listener that throws is reported and the others still hear the change', () => {
    // Given
    const { cell, failures } = recordingCell();
    const failure = new Error('listener broke');
    const heard: Status[] = [];
    cell.subscribe(() => {
      throw failure;
    });
    cell.subscribe(value => {
      heard.push(value);
    });

    // When
    cell.set('down');

    // Then
    expect(heard).toEqual(['down']);
    expect(failures).toEqual([{ error: failure, value: 'down' }]);
  });

  it('As a layer owner, an error handler that throws ends the round, and the next change reaches listeners alone', () => {
    // Given a cell whose error handler throws, and a listener that queues `up` and then throws on `booting`
    const cell = createStatusCell<Status>('idle', {
      onListenerError: error => {
        throw error;
      },
    });
    const heard: Status[] = [];
    cell.subscribe(value => {
      heard.push(value);
      if (value === 'booting') {
        cell.set('up');
        throw new Error('listener failed');
      }
    });
    expect(() => {
      cell.set('booting');
    }).toThrow('listener failed');

    // When the status changes again
    cell.set('down');

    // Then the listener hears the new status, not the change the failed round left queued
    expect(heard).toEqual(['booting', 'down']);
  });

  it('As a layer owner, a listener added during a round hears only later changes', () => {
    // Given a listener that subscribes another on `booting`, then moves the status on
    const { cell } = recordingCell();
    const late: Status[] = [];
    cell.subscribe(value => {
      if (value === 'booting') {
        cell.subscribe(next => {
          late.push(next);
        });
        cell.set('up');
      }
    });

    // When
    cell.set('booting');

    // Then
    expect(late).toEqual(['up']);
  });

  it('As a layer owner, a listener another one removes still hears the change in progress and nothing after it', () => {
    // Given a first listener that removes the second on `booting`, then moves the status on
    const { cell } = recordingCell();
    const heard: Status[] = [];
    let stopSecond = (): void => undefined;
    cell.subscribe(value => {
      if (value === 'booting') {
        stopSecond();
        cell.set('up');
      }
    });
    stopSecond = cell.subscribe(value => {
      heard.push(value);
    });

    // When
    cell.set('booting');

    // Then
    expect(heard).toEqual(['booting']);
  });

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

  it('As a layer owner, one listener subscribed twice is two subscriptions, each with its own removal', () => {
    // Given
    const { cell } = recordingCell();
    const heard: Status[] = [];
    const listener = (value: Status): void => {
      heard.push(value);
    };
    const stopFirst = cell.subscribe(listener);
    cell.subscribe(listener);

    // When
    stopFirst();
    cell.set('up');

    // Then
    expect(heard).toEqual(['up']);
  });
});
