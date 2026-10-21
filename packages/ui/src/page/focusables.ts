// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

const TABBABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]',
].join(', ');

/** The controls inside `root` that Tab reaches, in order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE))
    .filter(
      // Native tab order reaches unchecked radios with arrow keys, not Tab.
      el => !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked),
    )
    .filter(
      // A negative tabindex leaves a control to arrow keys, like unpressed segmented options.
      el => !(Number.parseInt(el.getAttribute('tabindex') ?? '0', 10) < 0),
    )
    .filter(
      // Skip controls CSS hides, like the sheet close button on desktop.
      el => typeof el.checkVisibility !== 'function' || el.checkVisibility(),
    );
}
