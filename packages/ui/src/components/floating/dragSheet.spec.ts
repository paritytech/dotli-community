// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createManualTimers } from '@dotli/shared/testing';
import { describe, expect, it } from 'vitest';
import { createDrags } from '../createDrags.js';
import { createRecordedLock, FakeHandle, dispatchPointer } from '../startDrag.fake.js';
import { dragSheet, type SheetSurface } from './dragSheet.js';

describe('dragSheet', () => {
  it('As a phone user, I swipe the sheet down past its threshold and lift, and it closes', () => {
    // Given a sheet held at its head
    const head = new FakeHandle();
    const surface = createFakeSurface(100);
    const closes: string[] = [];
    dragSheet({
      drags: createDrags({ selection: createRecordedLock().lock }),
      head,
      surface,
      down: { pointerId: 7, clientY: 0 },
      close: () => closes.push('close'),
    });

    // When the finger moves down past 30% of its height and lifts
    dispatchPointer(head, 'pointermove', { y: 80 });
    dispatchPointer(head, 'pointerup', { y: 80 });

    // Then the sheet closes and lets go of its drag look
    expect(closes).toEqual(['close']);
    expect(surface.style.transform).toBe('');
    expect(surface.attributes.has('data-dragging')).toBe(false);
  });

  it('As a phone user, I flick the sheet down a short way and lift, and it closes', async () => {
    // Given a tall sheet held at its head
    const timers = createManualTimers();
    const head = new FakeHandle();
    const surface = createFakeSurface(400);
    const closes: string[] = [];
    dragSheet({
      drags: createDrags({ selection: createRecordedLock().lock }),
      head,
      surface,
      down: { pointerId: 7, clientY: 0 },
      close: () => closes.push('close'),
      timers,
    });

    // When the finger moves 60px, well short of 30% of its height, and lifts 50ms after it went down
    dispatchPointer(head, 'pointermove', { y: 60 });
    await timers.advance(50);
    dispatchPointer(head, 'pointerup', { y: 60 });

    // Then the sheet closes and lets go of its drag look
    expect(closes).toEqual(['close']);
    expect(surface.style.transform).toBe('');
    expect(surface.attributes.has('data-dragging')).toBe(false);
  });

  it('As a phone user, I drag the sheet down the same short way slowly and lift, and it stays open', async () => {
    // Given a tall sheet held at its head
    const timers = createManualTimers();
    const head = new FakeHandle();
    const surface = createFakeSurface(400);
    const closes: string[] = [];
    dragSheet({
      drags: createDrags({ selection: createRecordedLock().lock }),
      head,
      surface,
      down: { pointerId: 7, clientY: 0 },
      close: () => closes.push('close'),
      timers,
    });

    // When the finger moves 60px and lifts 1s after it went down
    dispatchPointer(head, 'pointermove', { y: 60 });
    await timers.advance(1000);
    dispatchPointer(head, 'pointerup', { y: 60 });

    // Then the sheet stays open and lets go of its drag look
    expect(closes).toEqual([]);
    expect(surface.style.transform).toBe('');
    expect(surface.attributes.has('data-dragging')).toBe(false);
  });

  it('As a phone user, I have the sheet go away while I drag it, and its cleanup does not dismiss it again', () => {
    // Given a sheet dragged far down, whose finger has not lifted
    const head = new FakeHandle();
    const surface = createFakeSurface(100);
    const closes: string[] = [];
    const { lock, locks } = createRecordedLock();
    const drags = createDrags({ selection: lock });
    dragSheet({ drags, head, surface, down: { pointerId: 7, clientY: 0 }, close: () => closes.push('close') });
    dispatchPointer(head, 'pointermove', { y: 80 });

    // When the sheet's component cleans up
    drags.stopAll();

    // Then nothing is dismissed, the drag look is gone and text selection is back
    expect(closes).toEqual([]);
    expect(surface.style.transform).toBe('');
    expect(surface.attributes.has('data-dragging')).toBe(false);
    expect(locks).toEqual([true, false]);
  });

  it("As a phone user, I put a second finger on the sheet's head and it moves nothing", () => {
    // Given a sheet held by one finger at its head, and a second finger that went down on the same head
    const head = new FakeHandle();
    const surface = createFakeSurface(100);
    const closes: string[] = [];
    const drags = createDrags({ selection: createRecordedLock().lock });
    dragSheet({ drags, head, surface, down: { pointerId: 7, clientY: 0 }, close: () => closes.push('close') });
    dragSheet({ drags, head, surface, down: { pointerId: 8, clientY: 0 }, close: () => closes.push('close') });

    // When the second finger moves, then the first moves and lifts, then the second lifts
    dispatchPointer(head, 'pointermove', { pointerId: 8, y: 80 });
    const transformAfterSecondMoves = surface.style.transform;
    dispatchPointer(head, 'pointermove', { pointerId: 7, y: 10 });
    dispatchPointer(head, 'pointerup', { pointerId: 7, y: 10 });
    const closesAfterFirstLifts = [...closes];
    const transformAfterFirstLifts = surface.style.transform;
    const draggingAfterFirstLifts = surface.attributes.has('data-dragging');
    dispatchPointer(head, 'pointerup', { pointerId: 8, y: 80 });

    // Then the second finger moved nothing and neither lift closed the sheet
    expect(transformAfterSecondMoves).toBe('');
    expect(closesAfterFirstLifts).toEqual([]);
    expect(transformAfterFirstLifts).toBe('');
    expect(draggingAfterFirstLifts).toBe(false);
    expect(surface.style.transform).toBe('');
    expect(surface.attributes.has('data-dragging')).toBe(false);
    expect(closes).toEqual([]);
  });

  it("As a phone user whose drag missed its release, I press the sheet's head again and it keeps its drag look", () => {
    // Given a sheet dragged down by a finger whose lift never came
    const head = new FakeHandle();
    const surface = createFakeSurface(100);
    const closes: string[] = [];
    const drags = createDrags({ selection: createRecordedLock().lock });
    dragSheet({ drags, head, surface, down: { pointerId: 7, clientY: 0 }, close: () => closes.push('close') });
    dispatchPointer(head, 'pointermove', { pointerId: 7, y: 20 });

    // When the same finger presses the head again
    dragSheet({ drags, head, surface, down: { pointerId: 7, clientY: 0 }, close: () => closes.push('close') });

    // Then the held drag keeps the sheet where it was, with its drag look, and nothing closed
    expect(surface.style.transform).toBe('translateY(20px)');
    expect(surface.attributes.has('data-dragging')).toBe(true);
    expect(closes).toEqual([]);
  });
});

/** A sheet surface that keeps what the drag writes to it. */
function createFakeSurface(height: number): SheetSurface & { attributes: Set<string> } {
  const attributes = new Set<string>();
  return {
    attributes,
    offsetHeight: height,
    style: { transform: '' },
    setAttribute: name => attributes.add(name),
    removeAttribute: name => attributes.delete(name),
  };
}
