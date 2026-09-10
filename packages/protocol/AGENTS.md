# Protocol Package Instructions

## Testing Doctrine

1. **Dual-Driver Double**:
   - Use `createTestDApp` and `installProtocolFrame` from `tests/support/`.
   - Never mock DOM elements, iframes, or `window.postMessage` directly inside test files.

2. **Domain Getters**:
   - Assert on parsed domain getters (`frame.sentRpcRequests()`, `frame.connectionId()`, `dApp.replies()`).
   - Do not parse raw wire JSON strings inside test scenarios.

3. **Deterministic Virtual Time**:
   - Synchronize using `settleWithin`, `until`, and `bootAndConnect`.
   - Do not chain ad-hoc `elapse(1)` ticks or unanchored timeouts.

4. **Test Quality & Value**:
   - Tests must defend observable system contracts and failure boundaries.
   - Never write constructor-mirroring tests that assert properties passed directly into `new`.
