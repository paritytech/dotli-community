# Resolution timeline in the debug panel — analysis and plan

## Summary

Add a third panel view showing one resolution as four rows — Relay, Hub, People, Bulletin —
each row a horizontal run of blocks, one block per lifecycle state the chain passed through,
block width proportional to time spent in that state. Above the rows, whole-resolution
figures: average connection speed, total bytes, peak speed, outcome, and the cache results.

This is a **second, distinct view**, not an extension of the existing timeline. The current
one is an event timeline swimlaned by `genesisHash`; the new one is a state-duration chart
keyed by chain role. They answer different questions and share almost no geometry.

The work splits cleanly in two: the panel currently receives no lifecycle data at all, so
phase 1 is a new debug event carrying phase transitions, and phase 2 is the view that draws
them.

## Current state

**The existing timeline is event-shaped, not state-shaped.** `partitionIntoSwimlanes`
(`packages/truapi-debug/src/timeline-layout.ts:208`) buckets stored events into one swimlane
per `genesisHash`, plus `system` and `other`; `computeLayout`
(`timeline-layout.ts:306`) turns each bucket into request/response segments and point ticks.
Its only notion of "lifecycle" is chainHead follow output — `LIFECYCLE_COLORS`
(`timeline-layout.ts:81`) maps `Initialized` / `NewBlock` / `BestBlockChanged` / `Finalized` /
`Stop` to margin ticks. That is subscription traffic, not the light client's bootstrap
phases, and the two must not be conflated.

**The panel has no lifecycle data.** `DotliDebugEvent`
(`packages/truapi-debug/src/dotli-debug-types.ts:15`) is a union of boot, resolve, render,
bridge, failover, main and sandbox events. None carries a chain phase. Grepping the package
for `chainSync`, `syncKind`, `bootstrapComplete` or `warpSync` returns only prose in
`system-explanations.ts:100`. The nearest thing is `resolve.phase`
(`dotli-debug-types.ts:298`), whose payload is `{ label, phase, message }` — a resolver
progress string for the whole load, with no chain attribution.

**The lifecycle data exists, two realms away.** `chain-sync.ts:61` defines `CHAIN_SYNC_KINDS`
and `chain-sync.ts:73` `ChainSyncEvent`; those envelopes reach the host and are consumed at
`apps/host/src/main.ts:1251`. `packages/ui/src/network-monitor.ts:108` holds the derived
`ChainPhase` (`connecting | syncing | ready | stalled`) and `:110` `TransferState`
(bytesPerSecond, fetched, total).

**A derivation already exists but is uncommitted.** `apps/host/src/resolution-trace.ts` is
untracked in the working tree. It already turns the same envelopes into per-chain phase
intervals, peers, warp at/target, db-cache hit/miss and average and peak bytes per second —
`chainAttributes` at `resolution-trace.ts:394` — for Sentry.

**Correlation already works.** `bootFlowId` (`apps/host/src/main.ts:853`) is minted per page
load and travels as `flowId` on every system event; `event-store.ts:44` stores it and
`correlationKeyOf` (`event-store.ts:52`) already groups by it. One resolution is one
`flowId`. No new identity is needed.

**The panel is tab-based.** `PanelView` is `"list" | "timeline"` (`panel.ts:229`), with tab
buttons built at `panel.ts:310`. A third value is a small, local change.

## Options considered

**(a) Recompute in the panel from events already flowing.** Nothing to emit; the panel
derives phases from `resolve.phase` strings. Rejected: those strings describe the *load*, not
a chain, so per-chain rows cannot be reconstructed from them at all. This option cannot
produce the requested view.

**(b) Emit new debug events carrying phase transitions.** The host already consumes
`onProtocolChainSync` at `main.ts:1251` and already calls `emitDotliDebugEvent` 19 times in
the same file. Adding a `chain` layer alongside `boot` / `resolve` / `render` is the shape the
bus was built for, and the panel's store, filters and export get it for free. Cost: one new
event variant, and the panel derives durations by diffing consecutive transitions — the same
small diff `resolution-trace.ts` already does.

**(c) Share `resolution-trace.ts`'s derivation between Sentry and the panel.** Appealing
because the interval logic exists and is tested. Rejected for now on two grounds. It is
untracked and still under review, so depending on it couples this work to an unlanded change.
More fundamentally it is *lossy by design*: it samples at `DEFAULT_SAMPLE_RATE` and keeps only
aggregates, whereas the panel needs every transition on every load — a debug panel that shows
20% of loads is not a debug panel.

**Recommendation: (b).** It matches the bus's existing shape, keeps the panel's single source
of truth (the event stream) intact, and stays independent of the Sentry work's fate. The
duplicated diff logic is a handful of lines and the two consumers have genuinely different
requirements — one samples and aggregates, the other must be complete.

## Risks and unknowns

**A chain that never starts.** Bulletin is created only when the content phase begins, so on a
fast or cache-hit load it may produce no transitions at all. Its row must render as an
explicit "not started" rather than an empty lane that reads as a rendering bug. The same
applies to Relay, which is only followed because `observeChain` opens a connection for it.

**`rpc-gateway` has no lifecycle events whatsoever.** No light client runs, so zero
transitions are emitted and all four rows would be empty. The view must detect this from the
backend — `resolve.completed`'s payload carries `source: "smoldot" | "rpc-gateway"`
(`dotli-debug-types.ts:325`) — and say so, rather than showing four blank rows.

**A still-running resolution.** The last state of each chain has no end time. Draw it as an
open-ended block to the current time and re-render on a tick; do not omit it, because the
in-progress state is the one an engineer is usually staring at.

**Duplicate transitions.** A chain can attach more than one tap — Bulletin currently reports
`firstPeer` and `bootstrapComplete` twice, once from the warm-up connection and once from the
broker's. Settle cheaply by keying transitions per chain and ignoring a repeat of the current
phase, the same guard `enterPhase` uses in `resolution-trace.ts`.

**Event-store capacity.** `EventStoreConfig.capacity` (`event-store.ts:56`) drops oldest
events on overflow. A long session could evict the early transitions of the resolution being
viewed, silently truncating the first blocks of every row. Settle by checking whether the
capacity is reached in a normal session before deciding whether the view needs its own
retention.

**Unknown: where the summary figures come from on a cache hit.** `avg_bytes_per_second`
requires byte totals, which arrive via the `net-bytes` envelope consumed in the host. Whether
those are emitted on the cache-hit path at all has not been verified. Cheapest check: load a
warm page with the panel open and look for byte events.

## Phased plan

### Phase 1 — the panel can see chain phases

Goal: every lifecycle transition of every chain reaches the debug bus, tagged with the
resolution's `flowId`. No UI yet; verifiable in the existing List view.

1. Add a `ChainEvent` variant to `DotliDebugEvent` (`dotli-debug-types.ts`): `layer: "chain"`,
   `event: "phase"`, payload `{ chain, phase, peers?, warpAt?, warpTarget?, reason? }`.
2. Emit it from the host's existing `onProtocolChainSync` handler (`main.ts:1251`), reusing
   `bootFlowId` as `flowId`.
3. Ignore a repeat of the chain's current phase, so a second tap cannot double-count.
4. Add the backend and the cache results to the summary surface: `resolve.completed` already
   carries `source`; confirm what carries cid-cache and db-cache.

Exit criteria: with `VITE_APP_DEBUG=true`, a cold smoldot-direct load shows `chain/phase`
entries for all four chains in the List view, each with the same `flowId`, and an
`rpc-gateway` load shows none.

### Phase 2 — the Resolution view

Goal: the timeline itself.

1. Extend `PanelView` (`panel.ts:229`) to `"list" | "timeline" | "resolution"` and add the tab.
2. Add a pure `buildResolutionRows(events, flowId)` returning, per chain, an ordered list of
   `{ phase, startMs, endMs | null }` plus the chain's peers and warp figures.
3. Render four fixed rows in role order — Relay, Hub, People, Bulletin — blocks scaled to a
   shared time axis so rows are comparable. Colour by phase, reusing the network panel's
   existing phase palette so the two surfaces agree.
4. Render the summary header: average speed, total bytes, peak speed, outcome, cache results.
5. Handle the three empty cases explicitly: chain never started, `rpc-gateway`, still running.

Exit criteria: a cold load renders four rows whose block boundaries match the `chain/phase`
timestamps in the List view; an `rpc-gateway` load renders an explanation rather than blank
rows; a load still in flight renders its current blocks open-ended and advancing.

## Whole-resolution figures, and where each comes from

| Figure | Source |
|---|---|
| Average connection speed | byte totals ÷ elapsed, from the host's `net-bytes` consumption (`main.ts`) |
| Total bytes | same counter, final value |
| Peak speed | max delta between consecutive byte reports |
| Outcome | `resolve.completed` / `resolve.failed` (`dotli-debug-types.ts:320`, `:332`) |
| Backend | `resolve.completed.payload.source` |
| CID cache | `boot.cid_cache_checked` (`dotli-debug-types.ts:245`) |
| Archive cache | `sandbox.cache_checked` payload `hit` (`dotli-debug-types.ts:73`) |
| Time to first byte | first `net-bytes` report with a non-zero total |

Deliberately excluded: db-cache hit/miss per chain, which nothing currently emits to the bus —
it would ride the phase-1 event if wanted, and should not be listed until it does.

## Checklist

- [ ] Add `ChainEvent` to the debug event union — `packages/truapi-debug/src/dotli-debug-types.ts` — done when the type compiles and is part of `DotliDebugEvent`
- [ ] Emit phase transitions from the host — `apps/host/src/main.ts` — done when a cold load shows `chain/phase` entries for four chains in the List view
- [ ] Guard against repeated phases — `apps/host/src/main.ts` — done when Bulletin appears once per transition despite its two taps
- [ ] Add the `resolution` view to `PanelView` and the tab strip — `packages/truapi-debug/src/panel.ts` — done when the tab renders and switches
- [ ] `buildResolutionRows` as a pure function — `packages/truapi-debug/src/` (new module) — done when it returns ordered intervals per chain for a captured event array
- [ ] Render rows and blocks on a shared axis — new module + `styles.css` — done when block boundaries match List-view timestamps
- [ ] Render the summary header — same — done when every figure in the table above is shown or explicitly absent
- [ ] Handle never-started, `rpc-gateway`, and in-flight — same — done when each renders an explanation rather than a blank row
- [ ] Verify event-store capacity does not evict early transitions — `packages/truapi-debug/src/event-store.ts` — done when a long session still renders the full first row

Per the directive, this plan adds no tests to `packages/truapi-debug`. Note that it remains
the only package in the monorepo without any, and `buildResolutionRows` would be pure and
trivially testable if that changes.
