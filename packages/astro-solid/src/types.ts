// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { SSRResult } from 'astro';

/** The `this` Astro binds the server renderer's hooks to. */
export interface RendererContext {
  result: SSRResult;
}
