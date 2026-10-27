// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { createDrags } from './createDrags.js';
import { createRecordedLock, FakeHandle, dispatchPointer } from './startDrag.fake.js';

describe('createDrags', () => {
  it('As a component unmounting under two fingers, I stop my drags and both end with text selection back', () => {
    // Given two drags whose pointers never lift, as when the handle leaves the page under them
    const target = new FakeHandle();
    const ends: number[] = [];
    const { lock, locks } = createRecordedLock();
    const drags = createDrags({ selection: lock });
    drags.start({ target, down: { pointerId: 1 }, handlers: { move: () => undefined, end: () => ends.push(1) } });
    drags.start({ target, down: { pointerId: 2 }, handlers: { move: () => undefined, end: () => ends.push(2) } });

    // When the component cleans up
    drags.stopAll();
    dispatchPointer(target, 'pointerup', { pointerId: 1 });

    // Then each drag ended once and the page is selectable again
    expect(ends).toEqual([1, 2]);
    expect(locks).toEqual([true, false]);
  });

  it('As a component whose drag already ended, I stop my drags and only the one still going ends', () => {
    // Given one drag that ended on its own pointerup and one still held
    const target = new FakeHandle();
    const ends: number[] = [];
    const { lock, locks } = createRecordedLock();
    const drags = createDrags({ selection: lock });
    drags.start({ target, down: { pointerId: 1 }, handlers: { move: () => undefined, end: () => ends.push(1) } });
    drags.start({ target, down: { pointerId: 2 }, handlers: { move: () => undefined, end: () => ends.push(2) } });
    dispatchPointer(target, 'pointerup', { pointerId: 1 });

    // When the component cleans up
    drags.stopAll();
    drags.stopAll();

    // Then the ended drag did not end again, and the held one ended
    expect(ends).toEqual([1, 2]);
    expect(locks).toEqual([true, false]);
  });

  it('As a component unmounting mid-drag, I stop my drags and each hears it was not released', () => {
    // Given a drag still held
    const target = new FakeHandle();
    const ends: boolean[] = [];
    const drags = createDrags({ selection: createRecordedLock().lock });
    drags.start({
      target,
      down: { pointerId: 1 },
      handlers: { move: () => undefined, end: released => ends.push(released) },
    });

    // When the component cleans up
    drags.stopAll();

    // Then the drag ended as cancelled, so it commits nothing
    expect(ends).toEqual([false]);
  });

  it('As a component whose drag end throws, I stop my drags and the others still end, with the throw reported', () => {
    // Given two held drags, the first of which throws as it ends
    const captured: unknown[] = [];
    onTestFinished(bindCaptureSink({ exception: error => captured.push(error), expected: () => undefined }));
    const target = new FakeHandle();
    const ends: number[] = [];
    const { lock, locks } = createRecordedLock();
    const drags = createDrags({ selection: lock });
    const broke = new Error('end broke');
    drags.start({
      target,
      down: { pointerId: 1 },
      handlers: {
        move: () => undefined,
        end: () => {
          throw broke;
        },
      },
    });
    drags.start({ target, down: { pointerId: 2 }, handlers: { move: () => undefined, end: () => ends.push(2) } });

    // When the component cleans up
    drags.stopAll();

    // Then the second drag ended, every hold is free and the throw was reported
    expect(ends).toEqual([2]);
    expect(locks).toEqual([true, false]);
    expect(captured).toEqual([broke]);
  });
});
