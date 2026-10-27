// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { startDrag } from './startDrag.js';
import { createRecordedLock, FakeHandle, dispatchPointer } from './startDrag.fake.js';

const DOWN = { pointerId: 7 };

describe('startDrag', () => {
  it('As a drag handle, I capture the pointer and hear its moves until it is released', () => {
    // Given a handle and a lock that records the page's selection
    const target = new FakeHandle();
    const moves: number[] = [];
    const end = vi.fn();
    const { lock, locks } = createRecordedLock();

    // When a drag moves twice, lifts, then moves and lifts again
    startDrag({ target, down: DOWN, handlers: { move: event => moves.push(event.clientX), end }, selection: lock });
    dispatchPointer(target, 'pointermove', { x: 10 });
    dispatchPointer(target, 'pointermove', { x: 20 });
    dispatchPointer(target, 'pointerup');
    dispatchPointer(target, 'pointermove', { x: 30 });
    dispatchPointer(target, 'pointerup');

    // Then only the moves before the lift count, and the drag ended once as released
    expect(target.captured).toEqual([7]);
    expect(moves).toEqual([10, 20]);
    expect(end).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledWith(true);
    expect(locks).toEqual([true, false]);
  });

  it('As a drag handle whose pointer the browser cancels, I end the drag and hear it was not released', () => {
    // Given a drag that has moved once
    const target = new FakeHandle();
    const moves: number[] = [];
    const end = vi.fn();
    startDrag({
      target,
      down: DOWN,
      handlers: { move: event => moves.push(event.clientX), end },
      selection: createRecordedLock().lock,
    });
    dispatchPointer(target, 'pointermove', { x: 10 });

    // When the browser cancels the pointer, which no pointerup follows
    dispatchPointer(target, 'pointercancel');
    dispatchPointer(target, 'pointermove', { x: 20 });

    // Then the drag ended once, as not released, and heard no later move
    expect(moves).toEqual([10]);
    expect(end).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledWith(false);
  });

  it('As a component unmounting mid-drag, I call the returned stop and the drag ends once', () => {
    // Given a drag still held
    const target = new FakeHandle();
    const moves: number[] = [];
    const end = vi.fn();
    const { lock, locks } = createRecordedLock();
    const stop = startDrag({
      target,
      down: DOWN,
      handlers: { move: event => moves.push(event.clientX), end },
      selection: lock,
    });

    // When the component stops it twice, around a late move and lift
    stop();
    dispatchPointer(target, 'pointermove', { x: 10 });
    dispatchPointer(target, 'pointerup');
    stop();

    // Then the drag ended once and heard nothing after the stop
    expect(moves).toEqual([]);
    expect(end).toHaveBeenCalledTimes(1);
    expect(locks).toEqual([true, false]);
  });

  it('As a drag handle given a pointer the browser cannot capture, I start the drag and still follow it', () => {
    // Given a handle that cannot capture the pointer
    const target = new FakeHandle(false);
    const moves: number[] = [];

    // When a drag starts and moves
    startDrag({
      target,
      down: DOWN,
      handlers: { move: event => moves.push(event.clientX) },
      selection: createRecordedLock().lock,
    });
    dispatchPointer(target, 'pointermove', { x: 10 });

    // Then the move is heard
    expect(moves).toEqual([10]);
  });

  it('As a drag handle under two fingers, I follow each finger on its own and the page stays unselectable until both lift', () => {
    // Given two drags on one handle, one per finger
    const target = new FakeHandle();
    const first: number[] = [];
    const second: number[] = [];
    const { lock, locks } = createRecordedLock();
    startDrag({
      target,
      down: { pointerId: 1 },
      handlers: { move: event => first.push(event.clientX) },
      selection: lock,
    });
    startDrag({
      target,
      down: { pointerId: 2 },
      handlers: { move: event => second.push(event.clientX) },
      selection: lock,
    });

    // When each finger moves, the first lifts, then the second moves and lifts
    dispatchPointer(target, 'pointermove', { x: 10, pointerId: 1 });
    dispatchPointer(target, 'pointermove', { x: 20, pointerId: 2 });
    dispatchPointer(target, 'pointerup', { pointerId: 1 });
    const afterFirstLifts = [...locks];
    dispatchPointer(target, 'pointermove', { x: 30, pointerId: 2 });
    dispatchPointer(target, 'pointerup', { pointerId: 2 });

    // Then each drag heard only its own finger, and selection came back only after both lifted
    expect(first).toEqual([10]);
    expect(second).toEqual([20, 30]);
    expect(afterFirstLifts).toEqual([true]);
    expect(locks).toEqual([true, false]);
  });
});
