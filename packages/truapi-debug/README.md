# `@dotli/truapi-debug`

The data and logic behind the TrUAPI debug panel, with no UI. It collects host events, correlates calls with their
results and shapes them into rows, timelines and exports. The panel that draws them is a package of its own.

## Responsibility

- The debug event bus, the event store and the correlation of a call with its answer.
- Pure view models: filters, rows, timeline lanes, resolution blocks, pending-call tracking, export.
- Debug mode resolution and the panel's stored dock position and section.
- Not rendering. The panel renders these models. The host owns the call to start and stop the bus.

## Design

- The debug bus is the single channel. It creates no emitter until buffering is enabled, so sessions that never open
  debug mode pay nothing, and `emit` does nothing before then. Boot events are held until the first listener attaches,
  then replayed once. A throwing receiver is reported and the others still get the event. The bus is a lazy chunk.
- The event store keeps events unmodified. Each gets a stable sequence number, and a correlation key pairs a request
  with its response.
- A tracker follows open calls and marks the slow ones. A resolution recorder notes how a `.dot` name was resolved and
  builds its model.
- Filters, row and detail formatters and the timeline turn stored events into what the panel draws. Keys are stable, so
  the view updates a box in place as traffic streams in.
- A chain registry names chains and decodes their payloads for display.
- Debug mode, dock position and section are read and written through a passed-in storage.
- Everything takes its inputs as parameters, so the specs run under Node.

## Public API

### `@dotli/truapi-debug`

- Bus: `emitDotliDebugEvent`, `onDotliDebugEvent`, `watchDotliDebugEvents`, `hasDotliDebugListeners`,
  `loadDotliDebugBus`, `DotliDebugEvent`.
- Store: `EventStore`, `correlationKeyOf`, `firstNewIndex`, `StoredEvent`.
- Debug mode: `resolveDebugMode`, `isDebugModeOn`, `leaveDebugMode`, `readStoredDock`, `writeStoredDock`,
  `readStoredSection`, `writeStoredSection`.
- Views: `compileQuery`, `initialFilterState`, `matches`, `buildTimeline`, `buildResolution`,
  `createResolutionRecorder`, `truapiRowData`, `systemRowData`, `summariseSystemEvent`, `panelDockInset`.
- Detail: `chainDetail`, `explanationDetail`, `formatPayloadDetail`, `formatTime`, `formatLatency`, `siblingPills`.
- Pending calls and export: `OpenCallTracker`, `formatPending`, `buildExport`, `exportFilename`.

There is no `testing` export.
