// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { startDrag, type DragTarget } from './drag.js';

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
function pointer(target: EventTarget, type: string, x = 0): void {
  target.dispatchEvent(Object.assign(new Event(type), { pointerId: 7, clientX: x }));
}

const DOWN = { pointerId: 7 };

describe('startDrag', () => {
  it('As a drag handle, I capture the pointer and hear its moves until it is released', () => {
    // Given
    const target = new FakeHandle();
    const moves: number[] = [];
    const end = vi.fn();
    const locks: boolean[] = [];

    // When
    startDrag(target, DOWN, { move: event => moves.push(event.clientX), end }, locked => locks.push(locked));
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
    startDrag(target, DOWN, { move: event => moves.push(event.clientX), end }, () => undefined);
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
    const locks: boolean[] = [];
    const stop = startDrag(target, DOWN, { move: event => moves.push(event.clientX), end }, locked =>
      locks.push(locked),
    );

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
    startDrag(target, DOWN, { move: event => moves.push(event.clientX) }, () => undefined);
    pointer(target, 'pointermove', 10);

    // Then
    expect(moves).toEqual([10]);
  });
});
