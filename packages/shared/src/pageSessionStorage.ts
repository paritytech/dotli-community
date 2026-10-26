// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSafeStorage, type SafeStorage } from './createSafeStorage.js';

/** This tab's sessionStorage. */
export const pageSessionStorage: SafeStorage = createSafeStorage(() => sessionStorage);
