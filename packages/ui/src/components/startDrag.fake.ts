// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSelectionLock, type SelectionLock } from './createSelectionLock.js';
import type { DragTarget } from './startDrag.js';

type Params = {
  /** 0 by default. */
  x?: number;
  /** The drag's usual pointer, 7, by default. */
  pointerId?: number;
  /** 0 by default. */
  y?: number;
};

/** A drag handle over a plain event target, with the capture it was asked for. */
export class FakeHandle extends EventTarget implements DragTarget {
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

/** Node has no PointerEvent, so a plain event carries the fields a drag reads. */
export function dispatchPointer(target: EventTarget, type: string, { x = 0, pointerId = 7, y = 0 }: Params = {}): void {
  target.dispatchEvent(Object.assign(new Event(type), { pointerId, clientX: x, clientY: y }));
}

/** A selection lock that records each change the page would see. */
export function createRecordedLock(): { lock: SelectionLock; locks: boolean[] } {
  const locks: boolean[] = [];
  return {
    lock: createSelectionLock({
      apply(locked) {
        locks.push(locked);
      },
    }),
    locks,
  };
}
