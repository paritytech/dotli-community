// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the sign-in window does to its own page, such as closing it or going back.

/** The parts of a window its page closes with. */
export type ClosablePage = {
  /** Asks the browser to close the page, which it may refuse without a word. Never throws. */
  close(): void;
  readonly closed: boolean;
  /** Goes back to the page this one came from. Never throws. */
  history: { back(): void };
};

/**
 * Closes `page`, which the opener finds closed when its page gets focus or turns visible. A tab a site navigated to the
 * window cannot close itself, so the browser keeps it open and it goes back to the page it came from.
 */
export function closePage(page: ClosablePage): void {
  page.close();
  if (!page.closed) {
    page.history.back();
  }
}

/** Closes the window's own page, or goes back in history when the browser keeps it open. */
export function closeWindow(): void {
  closePage(window);
}
