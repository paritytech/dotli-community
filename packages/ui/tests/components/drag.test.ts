// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDrag } from '../../src/components/drag.js';

function pointer(target: EventTarget, type: string, x = 0): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    pointerId: 7,
    clientX: x,
  });
  target.dispatchEvent(event);
  return event;
}

function handle(): HTMLElement {
  const el = document.createElement('div');
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('startDrag', () => {
  it('As a drag handle, I capture the pointer and hear its moves until it is released', () => {
    // Given
    const target = handle();
    const capture = vi.spyOn(target, 'setPointerCapture').mockImplementation(() => undefined);
    const moves: number[] = [];
    const end = vi.fn();

    // When
    startDrag(target, new PointerEvent('pointerdown', { pointerId: 7 }), {
      move: event => moves.push(event.clientX),
      end,
    });
    pointer(target, 'pointermove', 10);
    pointer(target, 'pointermove', 20);
    pointer(target, 'pointerup');
    pointer(target, 'pointermove', 30);
    pointer(target, 'pointerup');

    // Then
    expect(capture).toHaveBeenCalledWith(7);
    expect(moves).toEqual([10, 20]);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('As a drag handle, a cancelled pointer ends the drag, since no pointerup follows it', () => {
    // Given
    const target = handle();
    const moves: number[] = [];
    const end = vi.fn();
    startDrag(target, new PointerEvent('pointerdown', { pointerId: 7 }), {
      move: event => moves.push(event.clientX),
      end,
    });
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
    const target = handle();
    const moves: number[] = [];
    const end = vi.fn();
    const stop = startDrag(target, new PointerEvent('pointerdown', { pointerId: 7 }), {
      move: event => moves.push(event.clientX),
      end,
    });

    // When
    stop();
    pointer(target, 'pointermove', 10);
    pointer(target, 'pointerup');
    stop();

    // Then
    expect(moves).toEqual([]);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('As a drag handle given a pointer the browser cannot capture, I still follow the drag', () => {
    // Given
    const target = handle();
    vi.spyOn(target, 'setPointerCapture').mockImplementation(() => {
      throw new DOMException('No active pointer', 'NotFoundError');
    });
    const moves: number[] = [];

    // When
    startDrag(target, new PointerEvent('pointerdown', { pointerId: 7 }), {
      move: event => moves.push(event.clientX),
    });
    pointer(target, 'pointermove', 10);

    // Then
    expect(moves).toEqual([10]);
  });
});
