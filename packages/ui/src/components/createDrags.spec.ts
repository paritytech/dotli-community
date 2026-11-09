// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { createDrags } from './createDrags.js';
import { createRecordedLock, FakeHandle, dispatchPointer } from './startDrag.fake.js';

describe('createDrags', () => {
  it('As a component whose drag is held, I refuse a second finger and it ends nothing', () => {
    // Given a drag held by pointer 1
    const target = new FakeHandle();
    const ends: number[] = [];
    const { lock, locks } = createRecordedLock();
    const drags = createDrags({ selection: lock });
    drags.start({ target, down: { pointerId: 1 }, handlers: { move: () => undefined, end: () => ends.push(1) } });

    // When a second finger goes down and lifts, and then the first lifts
    const second = drags.start({
      target,
      down: { pointerId: 2 },
      handlers: { move: () => undefined, end: () => ends.push(2) },
    });
    dispatchPointer(target, 'pointerup', { pointerId: 2 });
    const endsAfterSecond = [...ends];
    dispatchPointer(target, 'pointerup', { pointerId: 1 });

    // Then the second was refused and ended nothing, and the first ended once with text selection back
    expect(second).toBe(false);
    expect(endsAfterSecond).toEqual([]);
    expect(ends).toEqual([1]);
    expect(locks).toEqual([true, false]);
  });

  it("As a component whose drag missed its release, I take the same pointer's next press and the stale drag ends unreleased", () => {
    // Given a drag held by pointer 1 whose pointerup never came
    const target = new FakeHandle();
    const ends: string[] = [];
    const { lock, locks } = createRecordedLock();
    const drags = createDrags({ selection: lock });
    drags.start({
      target,
      down: { pointerId: 1 },
      handlers: { move: () => undefined, end: released => ends.push(`first ${String(released)}`) },
    });

    // When pointer 1 goes down again and then lifts
    const again = drags.start({
      target,
      down: { pointerId: 1 },
      handlers: { move: () => undefined, end: released => ends.push(`second ${String(released)}`) },
    });
    const endsAfterPress = [...ends];
    dispatchPointer(target, 'pointerup', { pointerId: 1 });

    // Then the stale drag ended unreleased, the new press was taken and ended released, with text selection back
    expect(again).toBe(true);
    expect(endsAfterPress).toEqual(['first false']);
    expect(ends).toEqual(['first false', 'second true']);
    expect(locks).toEqual([true, false, true, false]);
  });

  it('As a component whose drag ended, I take the next finger', () => {
    // Given a drag that ended on its own pointerup
    const target = new FakeHandle();
    const ends: number[] = [];
    const { lock, locks } = createRecordedLock();
    const drags = createDrags({ selection: lock });
    drags.start({ target, down: { pointerId: 1 }, handlers: { move: () => undefined, end: () => ends.push(1) } });
    dispatchPointer(target, 'pointerup', { pointerId: 1 });

    // When the next finger goes down and the component cleans up twice
    const next = drags.start({
      target,
      down: { pointerId: 2 },
      handlers: { move: () => undefined, end: () => ends.push(2) },
    });
    drags.stopAll();
    drags.stopAll();

    // Then the next finger was taken and its drag ended once
    expect(next).toBe(true);
    expect(ends).toEqual([1, 2]);
    expect(locks).toEqual([true, false, true, false]);
  });

  it('As a component unmounting mid-drag, I stop my drag and it hears it was not released', () => {
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

  it('As a component whose drag end throws, I stop my drag and its hold is freed, with the throw reported', () => {
    // Given a held drag that throws as it ends
    const captured: unknown[] = [];
    onTestFinished(bindCaptureSink({ exception: error => captured.push(error), expected: () => undefined }));
    const target = new FakeHandle();
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

    // When the component cleans up and the next finger goes down
    drags.stopAll();
    const next = drags.start({ target, down: { pointerId: 2 }, handlers: { move: () => undefined } });

    // Then the hold is free, the throw was reported and the next finger was taken
    expect(locks).toEqual([true, false, true]);
    expect(captured).toEqual([broke]);
    expect(next).toBe(true);
    dispatchPointer(target, 'pointerup', { pointerId: 2 });
    expect(locks).toEqual([true, false, true, false]);
  });
});
