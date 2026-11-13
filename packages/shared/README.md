# `@dotli/shared`

## Overview

Small helpers every package may use. Imports no UI framework.

## Responsibilities

- **Owns** the primitives other layers build on:
  - the async task pool
  - the state machine
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

| Export                                                                                                           | What it does                                                                                              |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `createAsyncTaskPool`, `AsyncTaskPool`                                                                           | Named task pool.                                                                                          |
| `createSharedRun`                                                                                                | One run shared by many callers.                                                                           |
| `createStateMachine`, `nest`, `MachineTypes`, `HandlersOf`, `HandlerOf`, `StateHandlers`, `Transition`, `Update` | Serial transitions over one state, with side effects run after each, and nested lifecycles run inside it. |
| `createLazyLoad`                                                                                                 | Loads once, retries on failure.                                                                           |
| `createListenerSet`, `ListenerSet`                                                                               | Ordered listener delivery.                                                                                |
| `createPendingReplies`, `PendingReplies`                                                                         | Pairs replies with requests.                                                                              |
| `createDeferred`, `markHandled`, `toAbortError`                                                                  | Promise helpers.                                                                                          |
| `waitForStatus`, `StatusSource`                                                                                  | Waits for a store's verdict.                                                                              |
| `registerStoreStateReset`, `registerAtomReset`                                                                   | Test resets for stores.                                                                                   |
| `isShallowEqual`, `isRecord`, `isStringArray`, `getKeys`, `Branded`                                              | Value checks and types.                                                                                   |
| `log`, `LogLevel`, `bindLogSink`, `LogEntry`                                                                     | The logger and its sink.                                                                                  |
| `serializeError`, `getErrorChain`, `getErrorName`, `getErrorMessage`, `toError`, `setErrorName`                  | Error reading and shaping.                                                                                |
| `combineErrors`, `runEvery`                                                                                      | Several errors as one.                                                                                    |
| `getEndpointHost`, `describeGatewayUnreachable`                                                                  | Endpoint copy for visitors.                                                                               |
| `createSafeStorage`, `SafeStorage`, `ListableStorage`, `pageLocalStorage`, `pageSessionStorage`                  | Web storage that never throws.                                                                            |
| `openIdb`, `IdbOpenBlockedError`, `waitForIdbRequest`, `runIdbTransaction`, `deleteIdb`                          | IndexedDB as promises.                                                                                    |
| `wipeOriginStores`, `OriginWipeError`, `OriginStores`, `OriginWipePart`                                          | Wipes one origin's stores.                                                                                |
| `listen`, `listenForDocumentVisible`, `listenForPageReturn`, `VisibilitySource`                                  | Event listeners that return stop.                                                                         |
| `formatSize`, `formatRate`, `formatDuration`, `formatElapsed`                                                    | Human-readable numbers.                                                                                   |
| `areBytesEqual`, `toHex`, `fromHex`, `hashBlake2b`                                                               | Bytes and hashing.                                                                                        |
| `withTimeout`, `startActiveTimeout`, `sleep`, `Timers`, `realTimers`                                             | Timing.                                                                                                   |
| `createRandomId`, `noop`                                                                                         | Small utilities.                                                                                          |
| `CHAIN_HALTED_ERROR_DATA`, `isChainHaltedRpcError`                                                               | Halted chain marker.                                                                                      |

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

- **Task pool:** the one place for async queues and concurrency limits. It is also the one place for retries and abort.
- **State machine:** transitions run synchronously, one at a time. Each state handles the events it names and ignores
  the rest. Effects a transition emits run in order after it. An event sent from inside a transition runs right after it
  and its effects. Async work enters as a promise that resolves to its event. A lifecycle nested in a state, such as one
  entry of a keyed set, is a value in that state. `nest` runs it through its own handlers. The state it emits is stored
  back, or dropped when it leaves.
- **Timing:** a deadline waits on active runtime. One the page was frozen past starts a whole span again on waking, and
  a freeze that ends before its due time still counts. `withTimeout` races work against one.
- **Safe storage:** blocked or full web storage reads as empty and drops writes. No module wraps storage itself.
- **Logger:** prints to the console only in debug builds (`VITE_APP_DEBUG`). Warn, error and event always reach the
  bound sink.
- **Origin wipe:** tries every part and rejects naming the parts it left behind.
- **Testing entry:** a separate entry, so no browser bundle reaches it.
