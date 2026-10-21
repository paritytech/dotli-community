// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSelectionLock, type DragTarget } from './drag.js';

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
export function pointer(target: EventTarget, type: string, x = 0, pointerId = 7, y = 0): void {
  target.dispatchEvent(Object.assign(new Event(type), { pointerId, clientX: x, clientY: y }));
}

/** A selection lock that records each change the page would see. */
export function recordedLock(): { lock: ReturnType<typeof createSelectionLock>; locks: boolean[] } {
  const locks: boolean[] = [];
  return { lock: createSelectionLock(locked => locks.push(locked)), locks };
}
