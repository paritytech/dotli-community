// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Test-only helpers, apart from the barrel so no browser bundle reaches them.

export { resetAllStoresForTests } from '../syncStore.js';
export { FakePage } from './fakePage.js';
export { manualTimers, type ManualTimers } from './manualTimers.js';
export { memoryStorage } from './memoryStorage.js';
export { must } from './must.js';
export { nth } from './nth.js';
export { recordLog, type LogLine } from './recordLog.js';
// Functional tests wait on the page through it. It reads the DOM, so only they call it.
export { untilDom } from './untilDom.dom.js';
