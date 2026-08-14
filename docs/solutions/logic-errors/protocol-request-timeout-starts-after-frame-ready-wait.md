---
title: Protocol request timeout started after the frame-ready wait, not at the call
date: 2026-08-14
last_updated: 2026-08-14
category: logic-errors
module: packages/protocol
problem_type: logic_error
component: service_object
symptoms:
  - First request against a cold or wedged protocol frame blocked up to roughly five minutes while advertising a 30 second timeout
  - Rejection did not say whether the time went into booting the frame or waiting for a reply
  - A dApp chain connection stacked 30s plus 240s plus 30s before any JSON-RPC error reached it
  - Every message sent during that window queued silently, so the chain looked unresponsive rather than failed
  - Timeout samples landed in the protocol.request latency series as the leftover budget, so p99 improved as the protocol degraded
root_cause: async_timing
resolution_type: code_fix
severity: high
tags:
  - protocol-client
  - timeout
  - iframe
  - request-budget
  - async-timing
  - metrics
  - mutation-testing
  - error-handling
  - dual-driver-dsl
---

# Protocol request timeout started after the frame-ready wait, not at the call

## Problem

`postRequest` advertised a per-method timeout and callers reasonably read it as the bound on the call. The timer was only created *after* awaiting the shared protocol iframe becoming ready, and that wait carries its own budgets. A first request against a cold or wedged frame could therefore block for up to roughly five minutes while reporting a 30 second contract, and the rejection never said where the time went. Fixed on branch `fix/protocol-request-call-time-budget` (issue #166), unmerged as of this writing.

## Symptoms

- A request with a 30 second budget could take up to `IFRAME_LOAD_TIMEOUT_MS` (30_000, `packages/protocol/src/client.ts:322`) plus `IFRAME_READY_TIMEOUT_MS` (240_000, `client.ts:326`) plus its own 30 seconds before rejecting — a worst case of roughly five minutes, of which the first four and a half are the frame wait alone.
- The rejection was a bare `Error` reading `Protocol request "<method>" timed out after <n>ms`, with nothing to distinguish a frame that never loaded from one that loaded but never signalled ready from one that never answered.
- `createRemoteChainProvider` awaited the frame outside any budget and only then issued `chainConnect`, so a dApp connecting during a cold boot waited out both frame budgets before the connection's own 30 seconds even started.
- During that window `send()` pushed every JSON-RPC message onto `pendingMessages` and returned nothing, so the dApp saw an unresponsive chain rather than a failure.
- The old timer called `stopReq()` on expiry, so a timeout recorded roughly the whole budget as a duration sample. Preserving that call after the fix would have recorded the *leftover* budget instead, because the budget now starts at the call while the roundtrip timer starts at the reply.

## What Didn't Work

- **Deadline arithmetic with `Date.now()`.** Compute `Date.now() + timeoutMs` once and re-check the remainder before each phase. Rejected: an NTP step or a laptop resume moves the bound underneath the request. A single `setTimeout` armed once is subject only to the timer queue.
- **`@std/async` from JSR.** `deadline()` constructs a fresh `AbortSignal.timeout(ms)` inside its own body, so every call starts a new window — which is precisely the defect being fixed. `abortable()` plus one shared `AbortSignal.timeout` can hold a deadline across sequential awaits, but `AbortSignal.timeout` exposes no cancel API, so the disarm on early completion becomes a no-op and every settled request leaves a timer running to full expiry. It also rejects with a fixed `DOMException`, so naming the phase still needs a re-wrap.
- **Emitting the phase counter from the guard's rejection path.** Proposed so that a load failure killing ten in-flight requests counts ten times instead of once. Rejected: the tie case already emits both a `PROTOCOL_REQUEST` timeout and a `PROTOCOL_IFRAME_READY` error for the same frame failure, and a second emission point widens that double-count. The reachability limit is documented instead: only the caller that creates the frame promise can report the `load` phase, because no method budget is below `IFRAME_LOAD_TIMEOUT_MS`.
- **Reducing a frame constant so the request budget would win.** Never attempted, and explicitly out of bounds: it would shorten the frame's own allowance for every caller to fix an ordering bug.

## Solution

One timer, armed at call time, raced against each phase in turn.

`startRequestBudget` (`client.ts:514`) creates a single `setTimeout` and returns a `RequestBudget` (`client.ts:502-505`) whose `guard(phase, work)` records which wait is running and races it against the shared expiry, and whose `release()` clears the timer (`client.ts:534-536`).

Before — the frame wait precedes the timer entirely:

```ts
async function postRequest<M extends ProtocolRequestMethod>(
  method: M,
  payload: ProtocolRequestMap[M],
  onProgress?: (message: string) => void,
  needsProtocolReady = /* ... */,
): Promise<unknown> {
  await (needsProtocolReady ? ensureProtocolFrame() : ensureHostFrame());
  // ... build the envelope ...
  const timeoutMs = UNTIMED_METHODS.has(method)
    ? null
    : (METHOD_TIMEOUTS[method] ?? DEFAULT_TIMEOUT_MS);
  const stopReq = m.timer(S.PROTOCOL_REQUEST);

  return new Promise((resolve, reject) => {
    const timer =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            pendingRequests.delete(id);
            m.count(S.PROTOCOL_REQUEST, { outcome: "timeout", method });
            stopReq();
            reject(
              new Error(
                `Protocol request "${method}" timed out after ${String(timeoutMs)}ms`,
              ),
            );
          }, timeoutMs);
    // ...
  });
}
```

After — the budget is armed first and covers every wait (`client.ts:606-621`):

```ts
const budget = startRequestBudget(method, timeoutMs);
try {
  await budget.guard("load", ensureHostFrame());
  if (needsProtocolReady) {
    await budget.guard("ready", ensureProtocolFrame());
  }
  const frameWindow = requireFrameWindow();
  const recordRoundtrip = m.timer(S.PROTOCOL_REQUEST);
  const sent = sendRequest(frameWindow, method, payload, onProgress);
  try {
    const value = await budget.guard("reply", sent.reply);
    recordRoundtrip();
    return value;
  } catch (error: unknown) {
    pendingRequests.delete(sent.id);
    throw error;
  }
} finally {
  budget.release();
}
```

Four further pieces:

- **A typed rejection.** `ProtocolRequestTimeoutError` (`packages/protocol/src/errors.ts:34`) carries `method`, `timeoutMs`, and a `phase` of `"load" | "ready" | "reply"` (`errors.ts:19`), rendered into the message from `PHASE_DESCRIPTIONS` (`errors.ts:21-25`). The phase is read when the timer fires, so it names the wait that actually consumed the budget rather than the wait the caller happened to start in.
- **The provider stops stacking.** `createRemoteChainProvider` (`client.ts:804`) now calls `postRequest("chainConnect", …)` directly (`client.ts:821`). The request already performs both frame waits, so the previous outer `ensureProtocolFrame()` was redundant as well as unbounded.
- **Failures record no duration.** `recordRoundtrip()` fires only on a completed roundtrip (`client.ts:617`). Because the budget starts at the call and this timer starts at the reply, sampling on a timeout would write the leftover budget — a 90 second failure landing as a 3 second sample in a series with no `outcome` attribute to filter on.
- **Dual-Driver test architecture.** Tests are structured into domain-focused suites in `packages/protocol/tests/` (`client-timeouts.test.ts`, `client-precedence.test.ts`, `client-chain-provider.test.ts`) driven by `DAppDriver` and `ProtocolFrame` doubles (`packages/protocol/tests/support/`), removing inline packet parsing and unencapsulated tick delays.

Consumers that mapped the timeout by message text were updated to match the type: `describeError` (`apps/host/src/errors.ts:45`) now tests `err instanceof ProtocolRequestTimeoutError` alongside the existing text match (`apps/host/src/errors.ts:90-92`), keeping the string branch for foreign timeouts that still need it.

No existing timeout constant was reduced, and `warmup` remains exempt from any budget (`client.ts:492-493`) because it waits on chain sync.

## Why This Works

- **The bound is measured from the moment the caller asked.** One `setTimeout` armed before any await covers load, ready, and reply, so the advertised per-method budget is the real ceiling instead of the last term in a sum.
- **The tie is resolved by construction.** The budget timer is created before the frame promise, and equal-expiry timers fire in creation order. Since no method budget is below `IFRAME_LOAD_TIMEOUT_MS`, a 30 second request against a frame that never loads reports its own timeout rather than the frame's — which is also the only reason the `load` phase is reachable at all.
- **A more specific frame error still wins when it genuinely settles first.** `Promise.race` keeps the first settlement, so `ProtocolFatalError`, `ProtocolInitFailedError`, and the frame-reset error continue to reach callers instead of being masked by a budget rejection.
- **Abandoning a shared wait is safe.** `Promise.race` attaches a handler to both operands, so a cached frame promise that a timed-out caller stopped awaiting cannot become an unhandled rejection, and a second caller still attached is unaffected.
- **The telemetry no longer improves as the system degrades.** Timeouts are counted with their phase and contribute no duration sample, so the latency series means completed roundtrips only.

## Prevention

- **A green suite is not evidence that a cleanup invariant is defended.** Deleting `budget.release()` left the suite fully green, and so did deleting `pendingRequests.delete(sent.id)`. Both mutations ship real damage: an undisarmed timer emits a spurious timeout count after the request already succeeded, and a missing delete leaks a pending entry holding the caller's progress callback. Assert cleanup through observable behaviour:
  - after a request resolves on a healthy frame, `expect(vi.getTimerCount()).toBe(0)` (`packages/protocol/tests/client-timeouts.test.ts:251`);
  - after a reply-phase timeout, deliver a late `progress` envelope for that request's id and assert the caller's callback was not invoked (`packages/protocol/tests/client-timeouts.test.ts:273`).
- **Probe the gate with mutations before trusting it.** Apply one mutation at a time to the real source, run the suite, restore. Six mutations each need a named failing scenario: dropping the timer disarm, dropping the pending-entry delete, restoring the provider's unbudgeted wait, arming the budget after the frame wait, giving `warmup` a budget, and relabelling a crash as the caller's own timeout. A mutation that leaves the suite green names a scenario that defends nothing.
- **Encapsulate protocol test plumbing behind Dual-Driver doubles.** Avoid inline JSON-RPC packet parsing (`JSON.parse(...)`) and multi-tick delays (`await elapse(1)`) in test scenarios. Use domain drivers (`createTestDApp`, `installProtocolFrame`) and temporal synchronization primitives (`settleWithin`, `until`, `bootAndConnect`).
- **A per-operation budget must cover the setup it depends on.** When an operation advertises a timeout, audit every `await` that precedes the timer for its own budget. The pattern to grep for is an unbudgeted readiness wait followed by a budgeted call: `await ensureX(); await withTimeout(op)`. Prefer letting the budgeted call own the readiness wait.
- **Never record a duration sample on a failure path in an attribute-less series.** The residual between a call-time budget and a later-started timer reads as a fast success and quietly flatters the percentile it should be inflating.
- **Attribute a timeout to the phase that consumed it, read at fire time.** Reconstructing the phase from which promise won the race is wrong whenever a shared wait is involved; a mutable cell set by each guard and read inside the timer callback is not.
- **When a consumer branches on an error, give it a type to branch on.** `apps/host/src/errors.ts` branched on ten distinct message substrings, so rewording a message silently changed user-facing copy and the recovery affordance. `apps/host` has no unit-test runner, so no test could have caught it — the type is the gate.

## Related Issues

- Issue #166 — the defect this documents.
- `docs/plans/2026-08-14-1856-fix-protocol-request-call-time-budget-plan.md` — the plan for this fix.
- `docs/smoldot.md` — describes `createRemoteChainProvider` and the protocol iframe.
