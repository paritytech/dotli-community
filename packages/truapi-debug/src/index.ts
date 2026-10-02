// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Public API of @dotli/truapi-debug. Other workspace packages import only from here.
// Every other module under src/ is private to the package.

export {
  chainDetail,
  eventCountLabel,
  explanationDetail,
  formatLatency,
  formatTime,
  groupDuration,
  memberDelta,
  siblingPills,
  type ChainDetail,
  type ChainField,
  type ExplanationBlock,
  type ExplanationDetail,
  type InlineSegment,
  type SiblingPill,
} from './detail-format.js';
export { readStoredDock, writeStoredDock, type DockPosition } from './dock-storage.js';
export {
  emitDotliDebugEvent,
  hasDotliDebugListeners,
  onDotliDebugEvent,
  type DotliDebugBusEvent,
} from './dotli-debug-bus.js';
export { type DotliDebugEvent } from './dotli-debug-types.js';
export {
  EventStore,
  correlationKeyOf,
  firstNewIndex,
  type EventSeq,
  type StoredEvent,
  type StoredSystemEvent,
  type StoredTruapiEvent,
  type TruapiDebugMessageEvent,
} from './event-store.js';
export { buildExport, exportFilename, type ExportMeta } from './export.js';
export { formatPayloadDetail } from './format.js';
export { compileQuery, initialFilterState, matches, type DirectionFilter, type FilterState } from './filters.js';
export { panelDockInset } from './iframe-layout.js';
export { OpenCallTracker, SLOW_AFTER_MS, formatPending, openCalls, pendingKeyOf } from './pending.js';
export {
  buildResolution,
  buildResolutionContainer,
  createResolutionRecorder,
  renderResolution,
  type ResolutionRecorder,
} from './resolution-view.js';
export { ridColor, rowSelection, systemRowData, tagKind, truapiRowData, type TagKind } from './row-format.js';
export { summariseSystemEvent } from './system-summary.js';
export { applyTimelineSelection, buildTimelineContainer, renderSwimlanes, resolveTimelineClick } from './timeline.js';
export { loadDotliDebugBus, type DotliDebugBusModule } from './lazy.js';
