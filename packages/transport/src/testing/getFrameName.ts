// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Names frames so a test asserts on the order of a conversation.

import type { RecordedFrame } from './readFrame.js';

/** How a test names a frame: its kind, or a call's tag and method, such as `request:notes.read`. */
export function getFrameName(heard: RecordedFrame): string {
  return heard.kind === 'call' ? `${heard.decoded?.tag ?? 'unknown'}:${heard.section}.${heard.method}` : heard.kind;
}
