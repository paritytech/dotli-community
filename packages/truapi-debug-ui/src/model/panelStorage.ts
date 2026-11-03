// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { PersistentAtomParams } from '@dotli/stores-persistent';

/**
 * Where the panel keeps its choices: a storage that never throws, such as the page's safe local storage. A raw
 * `localStorage` throws on a full quota, and that throw would reach the panel's own writes.
 */
export type PanelStorage = PersistentAtomParams<unknown>['storage'];
