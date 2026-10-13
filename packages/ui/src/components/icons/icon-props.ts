// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';

/** What every icon takes. Each draws in the current text color. */
export interface IconProps {
  /** Width and height in pixels. Unset, the icon keeps its own size, or the stylesheet sizes it when it has none. */
  size?: number | undefined;
  class?: JSX.ClassValue;
  testId?: string | undefined;
}
