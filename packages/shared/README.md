# `@dotli/shared`

## Overview

Small helpers every package may use. Imports no framework.

## Responsibilities

- **Owns** the primitives other layers build on:
  - the async task pool
  - the listener set
  - the logger
- **Owns** generic helpers with no other owner:
  - errors
  - encoding
  - formatting
  - timing
  - safe web storage
  - events
  - IndexedDB
  - the origin wipe
- **Owns** wire constants several packages share, such as the halted chain marker.
- **Does not own**:
  - page state
  - dotNS rules
  - metrics
  - UI
  - chain access
- The caller binds the log sink and reports listener errors.

## Public API

### `@dotli/shared`

| Export                                                                                          | What it does                      |
| ----------------------------------------------------------------------------------------------- | --------------------------------- |
| `createAsyncTaskPool`, `AsyncTaskPool`                                                          | Named task pool.                  |
| `createSharedRun`                                                                               | One run shared by many callers.   |
| `createLazyLoad`                                                                                | Loads once, retries on failure.   |
| `createListenerSet`, `ListenerSet`                                                              | Ordered listener delivery.        |
| `createPendingReplies`, `PendingReplies`                                                        | Pairs replies with requests.      |
| `createDeferred`, `markHandled`, `toAbortError`                                                 | Promise helpers.                  |
| `waitForStatus`, `StatusSource`                                                                 | Waits for a store's verdict.      |
| `registerStoreStateReset`, `registerAtomReset`                                                  | Test resets for stores.           |
| `isShallowEqual`, `isRecord`, `isStringArray`, `getKeys`, `Branded`                             | Value checks and types.           |
| `log`, `LogLevel`, `bindLogSink`, `LogEntry`                                                    | The logger and its sink.          |
| `serializeError`, `getErrorChain`, `getErrorName`, `getErrorMessage`, `toError`, `setErrorName` | Error reading and shaping.        |
| `combineErrors`, `runEvery`                                                                     | Several errors as one.            |
| `getEndpointHost`, `describeGatewayUnreachable`                                                 | Endpoint copy for visitors.       |
| `createSafeStorage`, `SafeStorage`, `ListableStorage`, `pageLocalStorage`, `pageSessionStorage` | Web storage that never throws.    |
| `openIdb`, `IdbOpenBlockedError`, `waitForIdbRequest`, `runIdbTransaction`, `deleteIdb`         | IndexedDB as promises.            |
| `wipeOriginStores`, `OriginWipeError`, `OriginStores`, `OriginWipePart`                         | Wipes one origin's stores.        |
| `listen`, `listenForDocumentVisible`, `listenForPageReturn`, `VisibilitySource`                 | Event listeners that return stop. |
| `formatSize`, `formatRate`, `formatDuration`, `formatElapsed`                                   | Human-readable numbers.           |
| `areBytesEqual`, `toHex`, `fromHex`, `hashBlake2b`                                              | Bytes and hashing.                |
| `withTimeout`, `sleep`, `Timers`, `realTimers`                                                  | Timing.                           |
| `createRandomId`, `noop`                                                                        | Small utilities.                  |
| `CHAIN_HALTED_ERROR_DATA`, `isChainHaltedRpcError`                                              | Halted chain marker.              |

### `@dotli/shared/testing`

| Export                                                       | What it does                         |
| ------------------------------------------------------------ | ------------------------------------ |
| `resetAllStoresForTests`                                     | Runs every registered reset.         |
| `createMemoryStorage`                                        | Storage in memory.                   |
| `createManualTimers`, `ManualTimers`                         | Timers a spec moves by hand.         |
| `createFakePage`, `FakePage`                                 | Fake document and window.            |
| `recordLog`, `LogLine`                                       | Records log lines.                   |
| `must`, `nth`, `catchError`, `catchRejection`, `readOutcome` | Assertion helpers.                   |
| `waitForDom`                                                 | DOM wait, for functional tests only. |

## Design

- **Task pool:** the one place for queues and concurrency limits. It is also the one place for retries and abort.
- **Timeout:** counts only time the page runs, so a frozen background tab does not time out.
- **Safe storage:** blocked or full web storage reads as empty and drops writes. No module wraps storage itself.
- **Logger:** prints to the console only in debug builds (`VITE_APP_DEBUG`). Warn, error and event always reach the
  bound sink.
- **Origin wipe:** tries every part and rejects naming the parts it left behind.
- **Testing entry:** a separate entry, so no browser bundle reaches it.
