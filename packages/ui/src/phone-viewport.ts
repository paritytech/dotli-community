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

/** Whether the viewport is a phone's now. */
export function isPhoneViewport(): boolean {
  return window.matchMedia(PHONE_QUERY).matches;
}
