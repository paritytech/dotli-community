// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export { isDebugModeOn, leaveDebugMode, resolveDebugMode, type DebugMode, type DebugModePage } from './debug-mode.js';
export {
  emitDotliDebugEvent,
  enableDotliDebugBuffering,
  hasDotliDebugListeners,
  onDotliDebugEvent,
  watchDotliDebugEvents,
  type DotliDebugBus,
  type DotliDebugBusEvent,
} from './dotli-debug-bus.js';
export type { DotliDebugEvent, TruapiDebugMessageEvent } from './dotli-debug-types.js';
