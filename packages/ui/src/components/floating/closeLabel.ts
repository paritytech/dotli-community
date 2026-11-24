// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';

/** The name of a head's close button: "Close" and its title when the title is text, else "Close" alone. */
export function getCloseLabel(title: JSX.Element): string {
  return typeof title === 'string' ? `Close ${title}` : 'Close';
}
