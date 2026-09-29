// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Public API of @dotli/truapi-debug. Other workspace packages import only from here;
// every other module under src/ is private to the package.

export {
  formatLatency,
  formatTime,
  renderGroupDetail,
  renderSingleDetail,
} from "./detail-html.js";
export {
  readStoredDock,
  writeStoredDock,
  type DockPosition,
} from "./dock-storage.js";
export {
  emitDotliDebugEvent,
  hasDotliDebugListeners,
  onDotliDebugEvent,
  type DotliDebugBusEvent,
} from "./dotli-debug-bus.js";
export { type DotliDebugEvent } from "./dotli-debug-types.js";
export {
  EventStore,
  correlationKeyOf,
  firstNewIndex,
  type EventSeq,
  type StoredEvent,
  type StoredSystemEvent,
  type StoredTruapiEvent,
  type TruapiDebugMessageEvent,
} from "./event-store.js";
export { buildExport, exportFilename, type ExportMeta } from "./export.js";
export {
  compileQuery,
  initialFilterState,
  matches,
  type DirectionFilter,
  type FilterState,
} from "./filters.js";
export { panelDockInset } from "./iframe-layout.js";
export {
  OpenCallTracker,
  SLOW_AFTER_MS,
  formatPending,
  openCalls,
  pendingKeyOf,
} from "./pending.js";
export {
  buildResolution,
  buildResolutionContainer,
  createResolutionRecorder,
  renderResolution,
  type ResolutionRecorder,
} from "./resolution-view.js";
export { rowClassName, systemRowData, truapiRowData } from "./row-format.js";
export {
  applyTimelineSelection,
  buildTimelineContainer,
  renderSwimlanes,
  resolveTimelineClick,
} from "./timeline.js";

// Lazy entry points. Each module is its own chunk, fetched on first call;
// a static re-export here would pull it into every importer's bundle.
export type DotliDebugBusModule = typeof import("./dotli-debug-bus.js");
export const loadDotliDebugBus = (): Promise<DotliDebugBusModule> =>
  import("./dotli-debug-bus.js");
