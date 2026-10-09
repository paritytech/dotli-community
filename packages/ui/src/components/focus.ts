// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Focus and scroll helpers for floating surfaces, modal layers and the topbar auto-hide. Solid-free.

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
export function focusFirst(candidates: Iterable<HTMLElement | SVGElement>): boolean {
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

let scrollLocks = 0;

/**
 * Lock page scroll through `data-scroll-locked` on the body until the last returned unlock runs.
 * Not an inline style: bridge.ts hides the body's overflow inline when the product frame attaches, and that
 * must outlive the dialog.
 */
export function lockScroll(): () => void {
  scrollLocks += 1;
  document.body.setAttribute('data-scroll-locked', '');
  let locked = true;
  return () => {
    if (!locked) {
      return;
    }
    locked = false;
    scrollLocks -= 1;
    if (scrollLocks === 0) {
      document.body.removeAttribute('data-scroll-locked');
    }
  };
}

export function focusLostOrInside(surface: HTMLElement | undefined): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || surface?.contains(active) === true;
}

/** Focus the trigger, or `fallback` (the More button) when the topbar has collapsed it into the More menu. */
export function focusTrigger(trigger: HTMLElement | undefined, fallback: HTMLElement | undefined): void {
  trigger?.focus();
  if (trigger !== undefined && document.activeElement !== trigger) {
    fallback?.focus();
  }
}
