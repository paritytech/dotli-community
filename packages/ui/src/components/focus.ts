// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Focus and scroll helpers for floating surfaces and modal layers.

import { focusables } from '@dotli/ui-core';

/** Keeps Tab and Shift+Tab inside `surface`. */
export function containTab(ev: KeyboardEvent, surface: HTMLElement): void {
  const items = focusables(surface);
  if (items.length === 0) {
    ev.preventDefault();
    surface.focus();
    return;
  }
  const active = document.activeElement;
  // By document position, not index: focus can sit on a tabindex -1 control, and the browser
  // tabs from there to the next stop after it, which may be outside.
  const side = ev.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
  const browserStaysInside =
    active !== null && surface.contains(active) && items.some(el => (active.compareDocumentPosition(el) & side) !== 0);
  if (!browserStaysInside) {
    ev.preventDefault();
    (ev.shiftKey ? items.at(-1) : items[0])?.focus();
  }
}

/** Focus the first element that takes focus, and report whether one did. */
function focusFirst(candidates: Iterable<HTMLElement | SVGElement>): boolean {
  for (const el of candidates) {
    el.focus();
    if (document.activeElement === el) {
      return true;
    }
  }
  return false;
}

/** Move focus into `surface` like Radix's FocusScope: the first candidate that takes focus, else the surface. */
export function focusInto(
  surface: HTMLElement,
  candidates: HTMLElement[] = focusables(surface).filter(el => !(el instanceof HTMLAnchorElement)),
): void {
  if (!focusFirst(candidates) && surface.hasAttribute('tabindex')) {
    surface.focus();
  }
}

/**
 * A refcounted page lock: each lock holds it, and `setLocked(false)` runs when the last returned unlock does.
 * An unlock that runs twice counts once.
 */
export function createScrollLock(setLocked: (locked: boolean) => void): () => () => void {
  let locks = 0;
  return () => {
    locks += 1;
    setLocked(true);
    let locked = true;
    return () => {
      if (!locked) {
        return;
      }
      locked = false;
      locks -= 1;
      if (locks === 0) {
        setLocked(false);
      }
    };
  };
}

/**
 * Lock page scroll through `data-scroll-locked` on the body until the last returned unlock runs.
 * Not an inline style: the page may set the body's overflow inline for its own layout, and that must outlive the
 * dialog.
 */
export const lockScroll = createScrollLock(locked => {
  document.body.toggleAttribute('data-scroll-locked', locked);
});

export function focusLostOrInside(surface: HTMLElement | undefined): boolean {
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
