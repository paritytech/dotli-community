// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The phone layout's breakpoint. At this width and below the bar is the
 * phone header, which never folds away (topbar-autohide.ts), the actions
 * live in More (topbar-status.ts), and popovers and menus open as bottom
 * sheets (create-popover.ts). The stylesheets repeat it as
 * `@media (max-width: 560px)`.
 */
export const PHONE_QUERY = '(max-width: 560px)';

// One list for the session: it is read on every focus change, every action
// group measure and every popover opening, and each matchMedia call parses
// the query and allocates a new one.
let phoneList: MediaQueryList | null = null;

function phoneQuery(): MediaQueryList {
  phoneList ??= window.matchMedia(PHONE_QUERY);
  return phoneList;
}

/** Whether the viewport is a phone's now. */
export function isPhoneViewport(): boolean {
  return phoneQuery().matches;
}

/**
 * Calls `onChange` with whether the viewport is a phone's each time it
 * crosses PHONE_QUERY. Returns a function that stops.
 */
export function watchPhoneViewport(onChange: (phone: boolean) => void): () => void {
  const query = phoneQuery();
  const notify = (): void => {
    onChange(query.matches);
  };
  query.addEventListener('change', notify);
  return () => {
    query.removeEventListener('change', notify);
  };
}

/** For tests: the next read asks `matchMedia` again, a stubbed one included. */
export function resetPhoneViewport(): void {
  phoneList = null;
}
