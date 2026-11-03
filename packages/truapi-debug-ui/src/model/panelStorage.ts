// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { SafeStorage } from '@dotli/shared';

/** Where the panel keeps its choices. `localStorage` is one. */
export type PanelStorage = Pick<SafeStorage, 'getItem' | 'setItem' | 'removeItem'>;
