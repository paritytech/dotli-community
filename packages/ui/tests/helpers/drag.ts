// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { vi } from 'vitest';

export function drag(el: HTMLElement, dy: number, ms: number): void {
  const now = vi.spyOn(performance, 'now');
  now.mockReturnValue(1000);
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientY: 100, button: 0 }));
  now.mockReturnValue(1000 + ms);
  el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientY: 100 + dy }));
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientY: 100 + dy }));
  now.mockRestore();
}
