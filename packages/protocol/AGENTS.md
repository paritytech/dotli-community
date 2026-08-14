# Protocol Package Instructions

Governs `packages/protocol` postMessage bridge, shared storage, and client-side chain provider.

## Package Invariants

| id | rule | gate |
|---|---|---|
| PROTO-T1 | Protocol tests use the dual-driver harness (`createTestDApp` / `installProtocolFrame`) from `tests/support/`; never mock `window.postMessage` or DOM elements inline in test files. | `! grep -E "addEventListener\(\"message\"|contentWindow" packages/protocol/tests/*.test.ts` |
| PROTO-T2 | Test scenarios assert on parsed domain getters (`frame.sentRpcRequests()`, `frame.connectionId()`, `dApp.replies()`); never parse raw `chainSend` message strings inside scenario bodies. | `! grep -E "JSON\.parse\(" packages/protocol/tests/*.test.ts` |
| PROTO-T3 | Asynchronous scenario synchronization must use virtual timer primitives (`settleWithin`, `until`, `bootAndConnect`); never chain ad-hoc tick yields (`await elapse(1)`). | Review of async wait patterns in `packages/protocol/tests/*.test.ts` |
