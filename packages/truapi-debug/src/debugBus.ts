// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createDebugBus } from './createDebugBus.js';

/**
 * The page's one debug bus. Emitters publish to it and subscribers receive what it holds.
 *
 * @example
 * debugBus.enableBuffering(); // a bus that is off delivers and holds nothing
 * const unsubscribe = debugBus.subscribe(showEvent);
 */
export const debugBus = createDebugBus();
