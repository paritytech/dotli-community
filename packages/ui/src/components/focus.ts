// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Keyboard focus within a floating surface or modal layer.

import { focusables } from '../page/focusables.js';

/** Keeps Tab and Shift+Tab inside `surface`. */
export function containTab(event: KeyboardEvent, surface: HTMLElement): void {
  const items = focusables(surface);
  if (items.length === 0) {
    event.preventDefault();
    surface.focus();
    return;
  }
  const active = document.activeElement;
  // By document position, not index: focus can sit on a tabindex -1 control, and the browser
  // tabs from there to the next stop after it, which may be outside.
  const side = event.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
  const browserStaysInside =
    active !== null &&
    surface.contains(active) &&
    items.some(item => (active.compareDocumentPosition(item) & side) !== 0);
  if (!browserStaysInside) {
    event.preventDefault();
    (event.shiftKey ? items.at(-1) : items[0])?.focus();
  }
}

/** Move focus into `surface` like Radix's FocusScope: the first candidate that takes focus, else the surface. */
export function focusInto(
  surface: HTMLElement,
  candidates: HTMLElement[] = focusables(surface).filter(candidate => !(candidate instanceof HTMLAnchorElement)),
): void {
  if (!focusFirst(candidates) && surface.hasAttribute('tabindex')) {
    surface.focus();
  }
}

/** Whether focus has dropped to the body or to nothing, or sits inside `surface`. Never throws. */
export function isFocusLostOrInside(surface: HTMLElement | undefined): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || surface?.contains(active) === true;
}

/** Focus the trigger, or `fallback` when something hid the trigger, like a bar collapsing it into a menu. */
export function focusTrigger(trigger: HTMLElement | undefined, fallback: HTMLElement | undefined): void {
  trigger?.focus();
  if (trigger !== undefined && document.activeElement !== trigger) {
    fallback?.focus();
  }
}

/** Focus the first element that takes focus, and report whether one did. */
function focusFirst(candidates: Iterable<HTMLElement | SVGElement>): boolean {
  for (const candidate of candidates) {
    candidate.focus();
    if (document.activeElement === candidate) {
      return true;
    }
  }
  return false;
}
