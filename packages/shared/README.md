# `@dotli/shared`

Small, framework-free helpers that every other package may use: logging, error serialization, the async task pool, the
listener set, the sync store, the status cell and a few formatting helpers.

## Responsibility

- Owns the primitives other layers build on: `createAsyncTaskPool`, `createListenerSet`, `createSyncStore`,
  `createStatusCell`, `log`.
- Owns generic helpers with no owner of their own: error copy, hex, byte sizes, timing, a timeout, abort, web storage
  that never throws, the IndexedDB callbacks as promises and the wipe of an origin's stores.
- Owns no page state, no dotNS rules, no metrics, no UI and no chain access. The log sink is bound from outside, and
  listener errors are reported through callbacks the caller passes in.

## Design

- One async task pool is the place for queueing, bounded concurrency, retries and abort. Callers name a pool and keep
  their task idempotent instead of hand-rolling in-flight flags.
- A module that waits takes `Timers`, the page's own by default, which read the globals at each call. A spec passes
  `manualTimers` and moves time itself, so it fakes no globals.
- The sync store imports no Solid. Notifications are synchronous, and every store registers a reset so tests can restore
  all of them at once. It stays off Solid so boot-path code does not ship Solid's core.
- A listener set delivers a value to every listener in order. A value emitted during delivery waits for the round in
  progress, and a listener that throws is reported through a callback while the others still hear the value. Each owner
  passes its own report.
- IndexedDB's callbacks become promises in one helper: an open that rejects when an older tab blocks the upgrade, a
  request, a transaction that resolves once it commits and rejects on an abort, and a delete that rejects when a
  connection blocks it.
- An origin wipe empties the databases, caches and service workers of one origin, each whatever happened to the one
  before, and rejects naming every part it left behind. A browser that cannot list its databases fails that part.
- Web storage that the browser blocks or that is full reads as empty and drops writes, in one adapter, so no module
  wraps storage itself.
- A pending-replies table pairs a request with the reply that carries its id. A settled id leaves the table, so a late
  reply settles nothing, and a dead channel fails every open wait at once.
- A lazy load runs one load at a time and keeps what it loaded for every later caller. A failed load rejects the caller
  that ran it and is not kept, so the next caller loads again, and only the first failure is passed to the caller's
  report hook.
- A status cell is the status a layer publishes upward, over one listener set. Setting an equal value is ignored.
- A timeout counts only time the page runs. A timer that fires seconds after it was due means the page was frozen, as a
  backgrounded phone tab is, and the work with it, so the wait starts its budget again.
- The logger writes to the console only in debug builds, read from the `VITE_APP_DEBUG` build flag at load so the first
  log of every entry point honours it. Warn, error and event always reach the sink bound with `bindLogSink`.
- Error helpers turn any thrown value into a string or a chain for wire formats, logs and Sentry.

## Public API

### `@dotli/shared`

- Concurrency and state: `createAsyncTaskPool`, `createLazyLoad`, `createListenerSet`, `ListenerSet`,
  `ListenerSetOptions`, `createSyncStore`, `StoreListenerError`, `registerStoreStateReset`, `shallowEqual`,
  `createStatusCell`, `toAbortError`, `createPendingReplies`, `PendingReplies`.
- Logging and errors: `log`, `bindLogSink`, `serializeError`, `fullErrorChain`, `errorName`, `errorMessage`, `toError`,
  `named`, `endpointHost`, `gatewayUnreachable`.
- Storage: `safeStorage`, `pageLocalStorage`, `pageSessionStorage`, `SafeStorage`.
- IndexedDB: `openIdb`, `idbRequest`, `idbTransaction`, `deleteIdb`.
- Origin wipe: `wipeOriginStores`, `deleteAllDatabases`, `OriginWipeError`, `OriginStores`, `OriginWipePart`.
- Byte counts as people read them: `formatSize`, `formatRate`.
- Encoding and timing: `toHex`, `fromHex`, `dur`, `elapsed`, `withTimeout`, `sleep`, `randomId`, `noop`, `Timers`,
  `realTimers`.

### `@dotli/shared/testing`

Test-only helpers, apart from the main entry so no browser bundle reaches them.

- `resetAllStoresForTests`, `deferred`, `memoryStorage`, `must`, `nth`, `manualTimers` (timers a spec moves by hand,
  which count the timers still pending), `FakePage` (a page with a document and a window, each firing the events the
  browser fires on it).
- `untilDom` waits on the page for functional tests. It reads the DOM, so only they call it.
