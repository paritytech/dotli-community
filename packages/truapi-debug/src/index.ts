// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

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
  type InlineSegment,
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
} from './event-store.js';
export { buildExport, exportFilename, type ExportMeta } from './export.js';
export { formatPayloadDetail } from './format.js';
export { compileQuery, initialFilterState, matches, type DirectionFilter, type FilterState } from './filters.js';
export { panelDockInset } from './iframe-layout.js';
export { OpenCallTracker, SLOW_AFTER_MS, formatPending, pendingKeyOf } from './pending.js';
export {
  buildResolution,
  createResolutionRecorder,
  type CacheResult,
  type ResolutionBlock,
  type ResolutionModel,
  type ResolutionRecorder,
  type ResolutionRow,
  type ResolutionSummary,
} from './resolution-view.js';
export { ridColor, rowSelection, systemRowData, tagKind, truapiRowData } from './row-format.js';
export { summariseSystemEvent } from './system-summary.js';
export { buildTimeline, type TimelineLane } from './timeline.js';
export { loadDotliDebugBus } from './lazy.js';
export { isAllocationEvent, observedAllocations, type AllocationOutcome } from './wallet-allocations.js';
export type {
  ExperimentalWalletControls,
  InspectorIdentity,
  InspectorProduct,
  InspectorResource,
  LocalIdentityProgress,
} from './wallet-types.js';
