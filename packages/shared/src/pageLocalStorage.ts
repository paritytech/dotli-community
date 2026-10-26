// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSafeStorage, type ListableStorage } from './createSafeStorage.js';

/** This origin's localStorage. */
export const pageLocalStorage: ListableStorage = createSafeStorage(() => localStorage);
