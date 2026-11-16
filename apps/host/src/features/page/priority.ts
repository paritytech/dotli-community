// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How early each topbar item moves into More when the bar runs out of room, the lowest first. One table, since the
// order only means something across the items.

import { PINNED } from '@dotli/ui';

export const TOPBAR_PRIORITY = {
  settings: 1,
  permissions: 2,
  chat: 3,
  network: 4,
  auth: PINNED,
} as const;
