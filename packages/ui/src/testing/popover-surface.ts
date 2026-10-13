// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type * as PopoverSurfaceModule from '../components/floating/PopoverSurface.js';

/** Fetches Popover's lazy surface, as the page's loader does. */
export const loadPopoverSurface = (): Promise<typeof PopoverSurfaceModule> =>
  import('../components/floating/PopoverSurface.js');
