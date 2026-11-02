// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createManualTimers } from '@dotli/shared/testing';
import { describe, expect, it } from 'vitest';
import { createFlash, type Flash } from './createFlash.js';

function createRecordedFlash(): {
  flash: Flash<string>;
  changes: (string | null)[];
  clock: ReturnType<typeof createManualTimers>;
} {
  const clock = createManualTimers();
  const changes: (string | null)[] = [];
  const flash = createFlash<string>({
    durationMs: 1000,
    onChange(value) {
      changes.push(value);
    },
    timers: clock,
  });
  return { flash, changes, clock };
}

describe('createFlash', () => {
  it('As a developer copying from the debug panel, I copy and the outcome shows for a moment before the control comes back', async () => {
    // Given
    const { flash, changes, clock } = createRecordedFlash();

    // When
    flash.show('copied');
    await clock.advance(1000);

    // Then
    expect(changes).toEqual(['copied', null]);
  });

  it('As a developer copying from the debug panel, I copy twice in a row and the second outcome shows for the full moment', async () => {
    // Given
    const { flash, changes, clock } = createRecordedFlash();
    flash.show('copied');
    await clock.advance(500);

    // When
    flash.show('failed');
    await clock.advance(999);
    const beforeTheMomentEnds = [...changes];
    await clock.advance(1);

    // Then
    expect(beforeTheMomentEnds).toEqual(['copied', 'failed']);
    expect(changes).toEqual(['copied', 'failed', null]);
  });

  it('As a developer copying from the debug panel, I hide the panel while a copy shows and nothing changes after', async () => {
    // Given
    const { flash, changes, clock } = createRecordedFlash();
    flash.show('copied');

    // When
    flash.dispose();
    await clock.advance(1000);

    // Then
    expect(changes).toEqual(['copied']);
  });

  it('As a developer copying from the debug panel, I hide the panel before the clipboard answers and the late answer writes nothing', async () => {
    // Given
    const { flash, changes, clock } = createRecordedFlash();
    flash.dispose();

    // When
    flash.show('copied');
    await clock.advance(1000);

    // Then
    expect(changes).toEqual([]);
  });
});
