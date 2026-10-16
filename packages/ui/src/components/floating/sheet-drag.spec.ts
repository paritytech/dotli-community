// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createDrags } from '../drag.js';
import { FakeHandle, pointer, recordedLock } from '../drag.fake.js';
import { dragSheet, type SheetSurface } from './sheet-drag.js';

/** A sheet surface that keeps what the drag writes to it. */
function fakeSurface(height: number): SheetSurface & { attributes: Set<string> } {
  const attributes = new Set<string>();
  return {
    attributes,
    offsetHeight: height,
    style: { transform: '' },
    setAttribute: name => attributes.add(name),
    removeAttribute: name => attributes.delete(name),
  };
}

describe('dragSheet', () => {
  it('As a phone user, I swipe the sheet down past its threshold and lift, and it closes', () => {
    // Given a sheet held at its head
    const head = new FakeHandle();
    const surface = fakeSurface(100);
    const closes: string[] = [];
    dragSheet(createDrags(recordedLock().lock), head, surface, { pointerId: 7, clientY: 0 }, () =>
      closes.push('close'),
    );

    // When the finger moves down past 30% of its height and lifts
    pointer(head, 'pointermove', 0, 7, 80);
    pointer(head, 'pointerup', 0, 7, 80);

    // Then the sheet closes and lets go of its drag look
    expect(closes).toEqual(['close']);
    expect(surface.style.transform).toBe('');
    expect(surface.attributes.has('data-dragging')).toBe(false);
  });

  it('As a phone user, I have the sheet go away while I drag it, and its cleanup does not dismiss it again', () => {
    // Given a sheet dragged far down, whose finger has not lifted
    const head = new FakeHandle();
    const surface = fakeSurface(100);
    const closes: string[] = [];
    const { lock, locks } = recordedLock();
    const drags = createDrags(lock);
    dragSheet(drags, head, surface, { pointerId: 7, clientY: 0 }, () => closes.push('close'));
    pointer(head, 'pointermove', 0, 7, 80);

    // When the sheet's component cleans up
    drags.stopAll();

    // Then nothing is dismissed, the drag look is gone and text selection is back
    expect(closes).toEqual([]);
    expect(surface.style.transform).toBe('');
    expect(surface.attributes.has('data-dragging')).toBe(false);
    expect(locks).toEqual([true, false]);
  });
});
