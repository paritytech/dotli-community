// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';

/** A frame with a bottom strip, for docking the panel at the bottom. */
export function DockBottomIcon(): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path d="M1.5 10h13" />
      <path fill="currentColor" fill-opacity=".4" d="M1.5 10h13v3.5h-13z" stroke="none" />
    </svg>
  );
}
