// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { createDrags, startDrag } from './drag.js';
import { FakeHandle, pointer, recordedLock } from './drag.fake.js';

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
    expect(end).toHaveBeenCalledWith(true);
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
    expect(end).toHaveBeenCalledWith(false);
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
  it('As a component unmounting under two fingers, I stop my drags and both end with text selection back', () => {
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

  it('As a component whose drag already ended, I stop my drags and only the one still going ends', () => {
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

  it('As a component unmounting mid-drag, I stop my drags and each hears it was not released', () => {
    // Given a drag still held
    const target = new FakeHandle();
    const ends: boolean[] = [];
    const drags = createDrags(recordedLock().lock);
    drags.start(target, { pointerId: 1 }, { move: () => undefined, end: released => ends.push(released) });

    // When the component cleans up
    drags.stopAll();

    // Then the drag ended as cancelled, so it commits nothing
    expect(ends).toEqual([false]);
  });

  it('As a component whose drag end throws, I stop my drags and the others still end, with the throw reported', () => {
    // Given two held drags, the first of which throws as it ends
    const captured: unknown[] = [];
    onTestFinished(bindCaptureSink({ exception: err => captured.push(err), expected: () => undefined }));
    const target = new FakeHandle();
    const ends: number[] = [];
    const { lock, locks } = recordedLock();
    const drags = createDrags(lock);
    const broke = new Error('end broke');
    drags.start(
      target,
      { pointerId: 1 },
      {
        move: () => undefined,
        end: () => {
          throw broke;
        },
      },
    );
    drags.start(target, { pointerId: 2 }, { move: () => undefined, end: () => ends.push(2) });

    // When the component cleans up
    drags.stopAll();

    // Then the second drag ended, every hold is free and the throw was reported
    expect(ends).toEqual([2]);
    expect(locks).toEqual([true, false]);
    expect(captured).toEqual([broke]);
  });
});
