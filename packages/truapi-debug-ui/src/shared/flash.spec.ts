// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { manualTimers } from '@dotli/shared/testing';
import { describe, expect, it } from 'vitest';
import { createFlash } from './flash.js';

function recordedFlash(): {
  flash: ReturnType<typeof createFlash<string>>;
  changes: (string | null)[];
  clock: ReturnType<typeof manualTimers>;
} {
  const clock = manualTimers();
  const changes: (string | null)[] = [];
  const flash = createFlash<string>({
    ms: 1000,
    onChange: value => {
      changes.push(value);
    },
    timers: clock,
  });
  return { flash, changes, clock };
}

describe('createFlash', () => {
  it('As a developer copying from the debug panel, I see the outcome for a moment and then the control comes back', async () => {
    // Given
    const { flash, changes, clock } = recordedFlash();

    // When
    flash.show('copied');
    await clock.advance(1000);

    // Then
    expect(changes).toEqual(['copied', null]);
  });

  it('As a developer copying twice in a row, I see the second outcome for the full moment', async () => {
    // Given
    const { flash, changes, clock } = recordedFlash();
    flash.show('copied');
    await clock.advance(500);

    // When
    flash.show('failed');
    await clock.advance(999);

    // Then
    expect(changes).toEqual(['copied', 'failed']);
    await clock.advance(1);
    expect(changes).toEqual(['copied', 'failed', null]);
  });

  it('As a developer who hid the panel while a copy was showing, I see nothing change after', async () => {
    // Given
    const { flash, changes, clock } = recordedFlash();
    flash.show('copied');

    // When
    flash.dispose();
    await clock.advance(1000);

    // Then
    expect(changes).toEqual(['copied']);
  });

  it('As a developer who hid the panel before the clipboard answered, I see the late answer write nothing', async () => {
    // Given
    const { flash, changes, clock } = recordedFlash();
    flash.dispose();

    // When
    flash.show('copied');
    await clock.advance(1000);

    // Then
    expect(changes).toEqual([]);
  });
});
