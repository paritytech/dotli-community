// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Test helpers apart from the barrel, so no browser bundle reaches them.

export type { RecordedMetric, RecordingSentry } from './bindRecordingSentry.js';
export { bindRecordingSentry } from './bindRecordingSentry.js';
export type { RecordedCapture } from './recordCaptures.js';
export { recordCaptures } from './recordCaptures.js';
