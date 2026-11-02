// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { IconProps } from '@dotli/ui/icons';

/** The shields are drawn at the stroke their place asks for. */
export type ShieldIconProps = {
  strokeWidth?: string | undefined;
} & IconProps;
