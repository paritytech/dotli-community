// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** What every icon of the panel takes. Each draws in the current text colour. */
export interface IconProps {
  /** Width and height in pixels, 12 when unset. */
  size?: number | undefined;
  testId?: string | undefined;
}
