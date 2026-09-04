---
title: Request timeout armed after asynchronous bootstrap creates unbounded wait
date: 2026-08-14
last_updated: 2026-08-14
category: logic-errors
module: protocol
problem_type: logic_error
component: service_object
symptoms:
  - First request against a cold or wedged protocol frame blocked up to five minutes while advertising a 30-second timeout
  - Rejections could not distinguish between a frame that failed to load, a frame stuck in presync, or a dropped RPC reply
  - Downstream dApp chain connections stacked setup timeouts before the connection allowance even started
  - Latency metrics for timed-out requests sampled only the residual budget, artificially improving reported p99 latency during outages
root_cause: async_timing
resolution_type: code_fix
severity: high
tags:
  - timeout-budget
  - async-timing
  - postmessage-bridge
  - metrics-integrity
  - mutation-testing
  - test-doubles
---

# Request timeout armed after asynchronous bootstrap creates unbounded wait

## Problem

When an asynchronous client advertises a per-operation timeout (e.g. 30s default, 90s for chain lookups) but arms its timer only *after* awaiting an underlying subsystem's readiness (such as a sandboxed host iframe, WebWorker, or chain presync), the advertised budget is violated. The total wait becomes the sum of the setup timeout plus the operation timeout (up to 5 minutes), while callers expect a strict 30-second bound.

Furthermore, when the timeout eventually fires, the rejection has lost context on where the time was spent, and metric histograms that record elapsed time on timeout sample only the residual fraction of the window, distorting service telemetry.

## Mechanism & Failure Modes

### 1. Cumulative Timeout Stacking
If setup carries an initial load allowance (30s) and a readiness allowance (240s), placing `await ensureReady()` before arming the per-request timer creates a sequential cascade:
$$\text{Max Latency} = T_{\text{load}} + T_{\text{ready}} + T_{\text{request}} \approx 300\text{s}$$
Callers programming to a 30-second deadline hang for 5 minutes during cold starts or worker stalls.

### 2. Loss of Phase Attribution
A single generic `TimeoutError` without phase metadata makes diagnosis impossible. A caller or telemetry consumer cannot tell whether:
- The host frame failed to load from network (`load` phase),
- The worker hung during chain presync (`ready` phase), or
- The remote chain RPC failed to answer (`reply` phase).

### 3. Metric Inversion on Failure
When a request budget starts at call time ($t=0$) but the latency stopwatch begins only when the message is dispatched to the frame ($t=t_{\text{ready}}$), measuring duration on timeout records only the *leftover* budget ($T_{\text{budget}} - t_{\text{ready}}$). A 90-second failure that spent 87 seconds waiting for readiness samples as a 3-second request, falsely pulling p95/p99 latency metrics downward during outages.

### 4. Teardown Orphan Leaks
If the underlying frame is reset or torn down while a request is awaiting a reply, failing to drain the pending request registry leaves caller promises hanging until their timeout timers expire, rather than failing fast with an explicit teardown error.

---

## Architectural Invariants

### 1. Unified Call-Time Budgeting
A single `setTimeout` must be armed at the public entry point before any setup or dispatch awaits occur. All subsequent asynchronous phases (`load`, `ready`, `reply`) are raced sequentially against that single deadline:

```ts
const budget = startRequestBudget(method, timeoutMs);
try {
  await budget.guard("load", ensureHostFrame());
  if (needsProtocolReady) {
    await budget.guard("ready", ensureProtocolFrame());
  }
  const sent = sendRequest(frameWindow, method, payload, onProgress);
  try {
    const value = await budget.guard("reply", sent.reply);
    recordRoundtrip();
    return value;
  } catch (error) {
    pendingRequests.delete(sent.id);
    throw error;
  }
} finally {
  budget.release();
}
```

### 2. Phase-Attributed Rejections
The timeout error must carry the exact phase in flight at the moment the timer fired (`load` | `ready` | `reply`), determined dynamically inside the timer callback rather than guessed from race winners.

### 3. Root-Cause Precedence
Explicit domain errors (such as peer crashes, frame load rejections, or session resets) must take precedence over budget expiration when settling first. `Promise.race` preserves the first settled rejection, preventing underlying crashes from being misattributed as client timeouts.

### 4. Metric Separation
Attribute-less latency metrics must record durations *only* for completed, successful roundtrips. Timeouts and failures must be emitted strictly as counter metrics tagged with the failure phase.

### 5. Immediate Teardown Drain
Any lifecycle transition that invalidates the underlying channel must synchronously drain and reject all in-flight pending requests with an explicit cancellation error.

---

## Verification & Prevention Rules

- **Enforce Two-Sided Timer Boundaries:** A timeout test must assert not just that a request fails at $T$, but that it remains pending and unresolved at $T - 1\text{ms}$.
- **Probe Cleanup Invariants with Mutation Gates:** A green test suite is not proof that cleanups work. Verify that removing `budget.release()` or `pendingRequests.delete(id)` causes a test to fail.
- **Dual-Driver Test Harness for Message Bridges:** Never mock DOM elements, iframes, or `postMessage` directly in test scenarios. Encapsulate the boundary into two domain drivers:
  - A **Consumer Driver** (`DAppDriver`) that sends requests and collects responses.
  - A **Peer Driver** (`ProtocolFrame`) that scripts frame state transitions (`open`, `ready`, `respond`, `fatal`).
- **Audit Unbudgeted Setup Awaits:** The code smell to grep for is an unbudgeted setup call preceding a budgeted operation:
  ```ts
  // ❌ Defect: Setup is outside the budget
  await ensureReady();
  await withTimeout(op, 30_000);

  // ✅ Invariant: Budget wraps setup and operation
  await withTimeout(async () => {
    await ensureReady();
    return op();
  }, 30_000);
  ```
