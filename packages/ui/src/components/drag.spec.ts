// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createDrags, createSelectionLock, startDrag, type DragTarget } from './drag.js';

/** A drag handle over a plain event target, with the capture it was asked for. */
class FakeHandle extends EventTarget implements DragTarget {
  readonly captured: number[] = [];
  readonly capturable: boolean;
  constructor(capturable = true) {
    super();
    this.capturable = capturable;
  }
  setPointerCapture(pointerId: number): void {
    if (!this.capturable) {
      throw new DOMException('No active pointer', 'NotFoundError');
    }
    this.captured.push(pointerId);
  }
}

// Node has no PointerEvent, so a plain event carries the fields a drag reads.
function pointer(target: EventTarget, type: string, x = 0, pointerId = 7): void {
  target.dispatchEvent(Object.assign(new Event(type), { pointerId, clientX: x }));
}

/** A selection lock that records each change the page would see. */
function recordedLock(): { lock: ReturnType<typeof createSelectionLock>; locks: boolean[] } {
  const locks: boolean[] = [];
  return { lock: createSelectionLock(locked => locks.push(locked)), locks };
}

const DOWN = { pointerId: 7 };

describe('startDrag', () => {
  it('As a drag handle, I capture the pointer and hear its moves until it is released', () => {
    // Given
    const target = new FakeHandle();
    const moves: number[] = [];
    const end = vi.fn();
    const { lock, locks } = recordedLock();

    // When
    startDrag(target, DOWN, { move: event => moves.push(event.clientX), end }, lock);
    pointer(target, 'pointermove', 10);
    pointer(target, 'pointermove', 20);
    pointer(target, 'pointerup');
    pointer(target, 'pointermove', 30);
    pointer(target, 'pointerup');

    // Then
    expect(target.captured).toEqual([7]);
    expect(moves).toEqual([10, 20]);
    expect(end).toHaveBeenCalledTimes(1);
    expect(locks).toEqual([true, false]);
  });

  it('As a drag handle, a cancelled pointer ends the drag, since no pointerup follows it', () => {
    // Given
    const target = new FakeHandle();
    const moves: number[] = [];
    const end = vi.fn();
    startDrag(target, DOWN, { move: event => moves.push(event.clientX), end }, recordedLock().lock);
    pointer(target, 'pointermove', 10);

    // When
    pointer(target, 'pointercancel');
    pointer(target, 'pointermove', 20);

    // Then
    expect(moves).toEqual([10]);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('As a component unmounting mid-drag, the returned stop ends the drag once', () => {
    // Given
    const target = new FakeHandle();
    const moves: number[] = [];
    const end = vi.fn();
    const { lock, locks } = recordedLock();
    const stop = startDrag(target, DOWN, { move: event => moves.push(event.clientX), end }, lock);

    // When
    stop();
    pointer(target, 'pointermove', 10);
    pointer(target, 'pointerup');
    stop();

    // Then
    expect(moves).toEqual([]);
    expect(end).toHaveBeenCalledTimes(1);
    expect(locks).toEqual([true, false]);
  });

  it('As a drag handle given a pointer the browser cannot capture, I still follow the drag', () => {
    // Given
    const target = new FakeHandle(false);
    const moves: number[] = [];

    // When
    startDrag(target, DOWN, { move: event => moves.push(event.clientX) }, recordedLock().lock);
    pointer(target, 'pointermove', 10);

    // Then
    expect(moves).toEqual([10]);
  });

  it('As a drag handle under two fingers, each drag hears only its own finger and the page stays unselectable until both lift', () => {
    // Given
    const target = new FakeHandle();
    const first: number[] = [];
    const second: number[] = [];
    const { lock, locks } = recordedLock();
    startDrag(target, { pointerId: 1 }, { move: event => first.push(event.clientX) }, lock);
    startDrag(target, { pointerId: 2 }, { move: event => second.push(event.clientX) }, lock);

    // When
    pointer(target, 'pointermove', 10, 1);
    pointer(target, 'pointermove', 20, 2);
    pointer(target, 'pointerup', 0, 1);
    const afterFirstLifts = [...locks];
    pointer(target, 'pointermove', 30, 2);
    pointer(target, 'pointerup', 0, 2);

    // Then
    expect(first).toEqual([10]);
    expect(second).toEqual([20, 30]);
    expect(afterFirstLifts).toEqual([true]);
    expect(locks).toEqual([true, false]);
  });
});

describe('createDrags', () => {
  it('As a component unmounting under two fingers, stopping my drags ends both and gives text selection back', () => {
    // Given two drags whose pointers never lift, as when the handle leaves the page under them
    const target = new FakeHandle();
    const ends: number[] = [];
    const { lock, locks } = recordedLock();
    const drags = createDrags(lock);
    drags.start(target, { pointerId: 1 }, { move: () => undefined, end: () => ends.push(1) });
    drags.start(target, { pointerId: 2 }, { move: () => undefined, end: () => ends.push(2) });

    // When the component cleans up
    drags.stopAll();
    pointer(target, 'pointerup', 0, 1);

    // Then each drag ended once and the page is selectable again
    expect(ends).toEqual([1, 2]);
    expect(locks).toEqual([true, false]);
  });

  it('As a component whose drag already ended, stopping my drags ends only the one still going', () => {
    // Given one drag that ended on its own pointerup and one still held
    const target = new FakeHandle();
    const ends: number[] = [];
    const { lock, locks } = recordedLock();
    const drags = createDrags(lock);
    drags.start(target, { pointerId: 1 }, { move: () => undefined, end: () => ends.push(1) });
    drags.start(target, { pointerId: 2 }, { move: () => undefined, end: () => ends.push(2) });
    pointer(target, 'pointerup', 0, 1);

    // When the component cleans up
    drags.stopAll();
    drags.stopAll();

    // Then the ended drag did not end again, and the held one ended
    expect(ends).toEqual([1, 2]);
    expect(locks).toEqual([true, false]);
  });
});
