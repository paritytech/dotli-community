# `@dotli/shared`

Small, framework-free helpers that every other package may use: logging, error serialization, the async task pool, the
sync store, the status cell and a few formatting helpers.

## Responsibility

- Owns the primitives other layers build on: `createAsyncTaskPool`, `createSyncStore`, `createStatusCell`, `log`.
- Owns generic helpers with no owner of their own: error copy, hex, byte sizes, timing and abort.
- Owns no page state, no dotNS rules, no metrics, no UI and no chain access. The log sink is bound from outside, and
  listener errors are reported through callbacks the caller passes in.

## Design

- One async task pool is the place for queueing, bounded concurrency, retries and abort. Callers name a pool and keep
  their task idempotent instead of hand-rolling in-flight flags.
- The sync store imports no Solid. Notifications are synchronous, and every store registers a reset so tests can restore
  all of them at once. It stays off Solid so boot-path code does not ship Solid's core.
- A status cell is the status a layer publishes upward. Setting an equal value is ignored, and a throwing listener is
  reported through a callback while the others still hear the change.
- The logger writes to the console only in debug builds, read from the `VITE_APP_DEBUG` build flag at load so the first
  log of every entry point honours it. Warn, error and event always reach the sink bound with `bindLogSink`.
- Error helpers turn any thrown value into a string or a chain for wire formats, logs and Sentry.

## Public API

### `@dotli/shared`

- Concurrency and state: `createAsyncTaskPool`, `DEFAULT_POOL`, `createSyncStore`, `StoreListenerError`,
  `registerStoreStateReset`, `shallowEqual`, `createStatusCell`, `toAbortError`.
- Logging and errors: `log`, `bindLogSink`, `serializeError`, `fullErrorChain`, `errorName`, `endpointHost`,
  `gatewayUnreachable`.
- Byte counts as people read them: `formatSize`, `formatRate`.
- Encoding and timing: `toHex`, `fromHex`, `dur`, `elapsed`.

### `@dotli/shared/testing`

Test-only helpers, apart from the main entry so no browser bundle reaches them.

- `resetAllStoresForTests`, `deferred`, `memoryStorage`, `must`, `nth`, `FakePage`.
- `untilDom` waits on the page for functional tests. It reads the DOM, so only they call it.
