// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Test-only helpers, apart from the barrel so no browser bundle reaches them.

export { resetAllStoresForTests } from '../storeResets.js';
export { catchError } from './catchError.js';
export { catchRejection } from './catchRejection.js';
export type { FakePage } from './createFakePage.js';
export { createFakePage } from './createFakePage.js';
export type { ManualTimers } from './createManualTimers.js';
export { createManualTimers } from './createManualTimers.js';
export { createMemoryStorage } from './createMemoryStorage.js';
export { must } from './must.js';
export { nth } from './nth.js';
export { readOutcome } from './readOutcome.js';
export type { LogLine } from './recordLog.js';
export { recordLog } from './recordLog.js';
// Functional tests wait on the page through it. It reads the DOM, so only they call it.
export { waitForDom } from './waitForDom.dom.js';
