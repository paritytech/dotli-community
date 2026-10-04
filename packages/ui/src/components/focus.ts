// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Focus and scroll helpers shared by the shell surfaces (shell/create-popover.ts),
// the overlay dialogs (overlays/Dialog.tsx) and the topbar's auto-hide
// (topbar-autohide.ts). Solid-free.

/** What a browser can focus (hidden and inert elements aside). */
export const FOCUSABLE =
  'a[href],area[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),iframe,summary,[tabindex],[contenteditable]';

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
      // Match native tab order: unchecked radios are reached with arrow keys
      // inside their group, not with Tab.
      el => !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked),
    )
    .filter(
      // A negative tabindex leaves a control to arrow keys, as the options of
      // a segmented control that are not pressed.
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
  // By document position, not by index: the focus can sit on a control
  // outside the Tab order (a tabindex -1 one, focused by a click or a
  // script), and the browser tabs from there to the next stop after it,
  // which may be outside.
  const side = ev.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
  const browserStaysInside =
    active !== null && surface.contains(active) && items.some(el => (active.compareDocumentPosition(el) & side) !== 0);
  if (!browserStaysInside) {
    ev.preventDefault();
    (ev.shiftKey ? items.at(-1) : items[0])?.focus();
  }
}

/** Focus the first element that takes focus; whether one did. */
export function focusFirst(candidates: Iterable<HTMLElement | SVGElement>): boolean {
  for (const el of candidates) {
    el.focus();
    if (document.activeElement === el) {
      return true;
    }
  }
  return false;
}

/**
 * Move focus into `surface` the way Radix's FocusScope does: the first of
 * `candidates` that takes focus (by default its tabbable controls, links
 * skipped), else the surface itself when it has a tabindex (only then can a
 * browser focus it).
 */
export function focusInto(
  surface: HTMLElement,
  candidates: HTMLElement[] = focusables(surface).filter(el => !(el instanceof HTMLAnchorElement)),
): void {
  if (!focusFirst(candidates) && surface.hasAttribute('tabindex')) {
    surface.focus();
  }
}

/** Open dialogs holding the page's scroll lock. */
let scrollLocks = 0;

/**
 * Lock page scroll until the returned function is called (more calls do
 * nothing), with `data-scroll-locked` on the body, which global.css turns
 * into `overflow: hidden !important`, as Radix's react-remove-scroll does.
 * The body's inline style stays the page's own: bridge.ts hides its
 * overflow when the product frame attaches, maybe while a dialog is open,
 * and that must outlive the dialog. Counted, so dialogs closing in any
 * order unlock the page only when the last one closes.
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
