// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Test-only helpers, apart from the barrel so no browser bundle reaches them.

export { resetAllStoresForTests } from '../sync-store.js';
export { deferred } from './deferred.js';
export { FakePage } from './fake-page.js';
export { memoryStorage } from './memory-storage.js';
export { must } from './must.js';
export { nth } from './nth.js';
// Functional tests wait on the page through it. It reads the DOM, so only they call it.
export { untilDom } from './until-dom.dom.js';
