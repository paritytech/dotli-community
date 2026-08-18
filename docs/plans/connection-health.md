# Connection health: analysis and plan

## Summary

Two related changes. On the loading screen, show the narration sentences from the first
paint instead of after a delay, and when the load is genuinely in trouble say what is
wrong using the throughput, peer count and stall reason already flowing through the
shell. In the network popover, replace a status verdict that is computed once and then
frozen with something that tracks the live connection, and render one bar per block per
chain coloured by whether that block arrived on time.

The block times were confirmed by measurement, and one of the assumptions behind the
request is wrong: Bulletin is a 6 second chain, not 2. See
[Block times](#block-times-confirmed).

The popover work is larger than it looks, because the current panel renders a table for
only one of three backends and polls on a 6 second interval that cannot express per-block
timing at all. That is a change of mechanism, not a faster poll.

## Current state

### Loading screen

The sentences already exist at first paint and are merely hidden. `index.html:300` ships
`<p id="status">Reaching out</p>`, and `.loading-status { opacity: 0 }` in
`packages/ui/src/styles/base.css` plus a `revealTimer` at `packages/ui/src/ui.ts:151-153`
withhold the block until `STATUS_REVEAL_MS = 3_000` (`packages/ui/src/ui.ts:162`). The
gate exists so a fast load shows only the logo and bar, never explanatory text. Removing
it is a one line change. Deciding what replaces that intent is the actual work.

A stall warning already exists. `describeStall` in `apps/host/src/warnings.ts:71-90`
composes a sentence from the live peer count, throughput and `stalled.reason`, armed per
critical chain by a watchdog at `apps/host/src/main.ts:1313-1346` with
`STALL_WARNING_MS = 3_000` (`apps/host/src/warnings.ts:16`). It deliberately returns
`null` when the peer count is unknown, because dwelling in one lifecycle state is normal:
measured healthy dwell in `connecting` was 3s, 8s and 11s for the three critical chains,
so warning on dwell alone fired on every single load.

What does not exist is any detector for the **bar** being stuck. The phase model advances
to a band target then creeps toward 99% (`packages/ui/src/ui.ts:72-73`), and on a run
where Bulletin never found a peer the bar sat at 99% for over 60 seconds while the
per-chain watchdog stayed quiet. "Loading is stuck at a percentage" is therefore a
genuinely new signal, not a tuning of the existing one.

### Network popover

The status line is a latched verdict. `describeNetworkStatus`
(`packages/ui/src/topbar.ts:1121-1135`) derives from `chainSyncState`, and the only
repaint path is `onStatusChange?.()` at `packages/ui/src/topbar.ts:1143`, called solely
from the chain-sync callback. Lifecycle milestones are terminal and the health poll stops
at `bootstrapComplete` (`packages/resolver/src/smoldot.ts:378`), so once the last chain
settles nothing fires again. "Your connection is good" is computed at that instant and
will keep saying so after the connection dies. This is the defect behind the request.

The table renders for one backend only. `rpc-gateway` and `smoldot-shared-worker` both
early-return a fixed string with no rows and no interval
(`packages/ui/src/topbar.ts:1166-1177`). Neither produces any lifecycle or peer signal at
all: `enableSyncReporting` is called once, inside direct mode
(`apps/protocol/src/main.ts:702-710`).

Data comes from a 6 second poll that creates and destroys one polkadot-api client per
chain per tick (`packages/ui/src/topbar.ts:2391`, `:2396`, `:2432`), each eagerly fetching
metadata. Per tick that is 4 clients and 8 runtime calls. A 6 second cadence cannot
express whether a 2 second block arrived on time.

Two structural obstacles:

- Rows are keyed by genesis hash from `getActiveServicesConfig()`
  (`packages/ui/src/topbar.ts:1189-1195`) while `chainSyncState` is keyed by `ChainKey`
  (`packages/ui/src/topbar.ts:1142`). No mapping exists anywhere in the tree. A visible
  consequence today: the status line can read "Connecting" while all four rows show fresh
  block ages, and the People row contributes no lifecycle state because People is absent
  from the `milestones` list.
- Bulletin is structurally unreachable in gateway mode. `getActiveGatewayChains()`
  hardcodes `[cfg.relay, cfg.assethub, cfg.people]`
  (`packages/config/src/network.ts:548-551`), so `isRemoteChainSupported`
  (`packages/protocol/src/client.ts:751-759`) rejects it even on networks where
  `bulletin.rpcs` is populated. Only `getActiveCoreGatewayChains()` includes it.

### Block times, confirmed

The repo encodes no block time. `grep -rniE "block.?time|slot.?duration|expectedblock"`
over `packages` and `apps` returns nothing in source, and the chain specs carry only
`genesis.stateRootHash` plus token properties. Measured live on 2026-08-18:

| Chain | Designed | paseo-next-v2 measured | previewnet measured | Runtime source |
|---|---|---|---|---|
| Relay | 6s | 6000ms over 200 blocks | 6000ms over 200 blocks | `Babe.ExpectedBlockTime = 6000` |
| AssetHub | 2s | 2010ms over 2000 blocks | ~2460ms | velocity 3 over a 6000ms relay slot |
| People | 2s | 2010ms over 2000 blocks | ~7440ms | velocity 3 over a 6000ms relay slot |
| Bulletin | **6s** | 6018ms over 2000 blocks | ~6600ms | velocity **1** over a 6000ms relay slot |

Three conclusions that change the design:

1. **Bulletin is 6 seconds, not 2.** Its `BLOCK_PROCESSING_VELOCITY` is 1 where AssetHub
   and People use 3. Colouring Bulletin against a 2 second expectation would paint a
   healthy chain permanently red.
2. The 2 second figure is right for AssetHub and People but for a different reason than
   assumed. It is elastic scaling producing three blocks per 6 second relay slot, not a 2
   second slot. `Aura.SlotDuration` reads 12000 on both and 24000 on Bulletin, so it is
   actively misleading. Stale functional-test logs in this repo corroborate that
   independently: smoldot logs `slot_duration=12000ms` for asset-hub and bulletin.
3. **previewnet does not hit the designed rate for any parachain.** AssetHub ~2.5s,
   Bulletin ~6.6s, People ~7.4s, because relay slots get skipped. Since previewnet is the
   only network currently usable for development, thresholds keyed purely to designed
   rates would show amber or red constantly on the network we test against.

No single runtime constant yields parachain block time. `Timestamp.MinimumPeriod` is 0 on
all three, and velocity is a Rust generic absent from metadata. Two derivations do work:
read `AuraExt.RelaySlotInfo` and take the maximum authored count as velocity, or average
observed arrival spacing.

### Label mapping, confirmed

All four are required non-optional fields of `ServicesConfig`
(`packages/config/src/network.ts`), so neither active network can be missing one.

| Label | Config key | Note |
|---|---|---|
| Relay | `relay` | previewnet's is a local dev relay |
| General | `assethub` | holds the DotNS registry |
| Storage | `bulletin` | only key with `ipfsGateways`, only one excluded from gateway mode |
| Identity | `people` | previewnet chain id is `individuality-local` |

## Options considered

### Per-block arrival timing

| | A. `chainHead_v1_follow` from the host via low-level client | B. Same follow via `papi.createClient().blocks$` | C. Push stream from the protocol context |
|---|---|---|---|
| Code | ~60 lines, own the unfollow, unpin and header decode | ~10 lines, papi owns pins | ~40 lines plus a new protocol envelope |
| Metadata cost | none | 2 runtime calls and a full decode per chain | none |
| Backend coverage | all three | all three | direct and rpc only, cannot ship alone |
| Risk | hand-rolled pin and stop handling | metadata traffic on four chains on mobile | new protocol surface for no gain today |

**Recommendation: A.** It is the only option covering all three backends, and it *removes*
the existing per-tick metadata churn rather than making it permanent. It also rides the
one subscription shape the broker already shares: shared follows are keyed by
`JSON.stringify(request.params)` and a late joiner gets `replayFollowSnapshot`
(`packages/protocol/src/broker.ts:1086-1120`), so a follow with identical params collapses
onto the resolver's existing upstream follow at no network cost. Net change versus today:
4 clients plus 8 metadata calls every 6 seconds becomes 4 follows for the session and zero
metadata. B is a two line variant and the fallback if pin handling proves fiddly.

Colour the **best-block change**, not every `newBlock`, so forks do not double count.
Decode headers with `blockHeader` from `@polkadot-api/substrate-bindings`, already a
`@dotli/ui` dependency at version 0.20.3 though not yet imported anywhere.

Honest limitation: under a light client a parachain head is learned through relay-chain
inclusion, so arrival intervals are burstier than real authoring intervals. Arrival is
still the right thing to colour, because it is what the user's session actually has. Cover
the blind spot of regular arrivals while minutes behind with one `Timestamp::Now` read per
open, reusing `queryBlockAgeMs` (`packages/ui/src/topbar.ts:2294`).

### Thresholds

| Source | Verdict |
|---|---|
| Per-chain `blockTimeMs` in `ServicesConfig` | **Recommended.** Config already owns per-network per-chain facts and is the only module that knows the active network. Must be per network, not per chain role, because previewnet differs from paseo-next-v2. |
| Runtime read | Reject. No constant gives it, and the two that look like it are misleading. |
| Observed rolling median | Keep as the fallback when a configured value is absent, and as the previewnet answer if configured values prove unusable there. Needs ~5 samples before a colour means anything and cannot see a uniformly slow chain. |

Colour against the chain's expected time: green to 1.5x, amber to 3x, red beyond. Colour
the trailing in-progress bar by time since the last block on the same scale, so a dead
chain goes red while you watch rather than showing nothing.

### What to take from the three existing prototypes

Branches `net-status-dots` (f952b4e7), `net-status-cards` (2725b6cf) and
`net-status-topology` (e6dc52da) each solved per-network status against the same data.
Take from them: the monotonic milestone rank, so a late `stalled` cannot erase that a
chain bootstrapped, the rule that only a live peer sample may colour anything, and the
light-theme contrast fixes, since `is-ok` and `is-warn` had **no** light override and sat
at 2.28:1 and 1.92:1. Discard their layouts, all three of which assume the polling model
this plan replaces.

## Risks and unknowns

| Risk | Consequence | Cheapest resolution |
|---|---|---|
| previewnet runs slower than designed | Bars amber or red constantly on the only usable dev network | Ship the configured value and the observed median together behind one flag, compare on previewnet for a day, keep whichever tells the truth |
| SharedWorker chain cap is 10 **shared across tabs** (`apps/protocol/src/protocol-shared-worker.ts:96`) | 4 follows means 3 open tabs exhaust it and connections are refused | Never hold follows for a panel nobody opened; 60 second idle grace then unfollow |
| `resetProtocolFrameState` drops the iframe without clearing `chainConnections` or notifying anyone (`packages/protocol/src/client.ts:167-183`) | A monitor silently receives nothing forever after a frame reset | Silence detection, no event for 3x expected plus slack, then rebuild. Worth fixing at the source in the same change |
| `custom-relay` is a fifth live chain with no `ServicesConfig` entry (`packages/config/src/config.ts:131-132`) | A configured relay with no row and no block time | Map it onto the Relay role, as `apps/host/src/main.ts:1384` already does |
| `paseo-next-v1` ships in release artifacts with `bulletin.rpcs: []` and `people.rpcs: []` | Storage and Identity rows with no endpoint in a released build | Render "not available on this network" rather than `n/a` |
| Removing the 3s reveal | Every fast load now shows explanatory text it previously hid | Decide deliberately whether that intent still holds; it may simply be obsolete now the sentences are good |

Unknown worth naming: whether Bulletin bars are achievable at all in gateway mode. The
honest answer today is no through the popover's path, and the plan should render Storage as
served over the IPFS gateway rather than opening a connection.

## Phased plan

### Phase 1: loading screen tells the truth immediately

Goal: sentences from first paint, and a warning that fires when the bar itself is stuck,
not only when a chain dwells.

1. Remove the reveal gate: drop `revealTimer` and `STATUS_REVEAL_MS`
   (`packages/ui/src/ui.ts:151-153`, `:162`) and the `opacity: 0` default on
   `.loading-status`. Keep the block in the DOM at first paint.
2. Add a bar-stall detector in `packages/ui/src/ui.ts`: if `currentProgress` is unchanged
   for a threshold while a load is running, notify a listener. Export it rather than
   wiring copy inside `ui.ts`.
3. Extend `apps/host/src/warnings.ts` with a bar-stall message that quotes throughput when
   it is the limiting factor, and add the percentage to the facts it receives. Keep the
   existing rule that absence of information produces no warning.
4. Subscribe the host to the new detector alongside the per-chain watchdog, so one
   warning surface serves both causes.

Exit criteria: on a cold previewnet load, the first sentence is present in the first
painted frame, verified from a browser measurement rather than inferred. On a load where
Bulletin has no peer, a warning naming the throughput or peer count appears while the bar
is parked. A healthy load still shows no warning at all.

### Phase 2: one key, and block times in config

Goal: the foundation both surfaces need, with no visible change.

1. Add `ChainRole = "relay" | "assethub" | "bulletin" | "people"` to
   `@dotli/config/network`, plus `getActiveChainRoles()` returning
   `{ role, label, genesis, blockTimeMs }` and `chainRoleForGenesis(hash)`. Config cannot
   import the resolver, so `ChainKey` stays out of it.
2. Add `blockTimeMs` per chain per network to `ServicesConfig`, using the measured designed
   values: relay 6000, assethub 2000, bulletin 6000, people 2000. Record in a comment that
   Bulletin differs because its velocity is 1, so nobody "fixes" it to 2000 later.
3. Own the wire-name bridge in exactly one place: a five entry
   `Record<ChainKey, ChainRole>` mapping `asset-hub` to `assethub` and `custom-relay` to
   `relay`. Leave `event.chain` alone, other consumers compare it directly.

Exit criteria: typecheck passes with the role record exhaustive over `ChainKey`, so a chain
added upstream fails the build here. No UI behaviour changes.

### Phase 3: a live monitor replaces the poll

Goal: real per-block data, for every backend that can supply it.

1. New `packages/ui/src/network-monitor.ts`, page scoped, exporting
   `startNetworkMonitor`, `stopNetworkMonitor`, `subscribeNetwork(cb)` returning an
   unsubscribe, and `getChainBars(role)`. Take the follow factory as an injected argument
   so tests can drive synthetic block events.
2. One `chainHead_v1_follow` per supported role, stamping `Date.now()` on each best-block
   change. 40 bar ring buffer per role, keyed by `ChainRole`.
3. Lifecycle. Create on first open. Attach only a render subscriber on subsequent opens.
   On close keep follows for a 60 second idle grace, then unfollow and disconnect.
   Re-following after the grace relies on the broker's snapshot replay. Unfollow on
   `pagehide`. Render an unwatched period as a gap, never as red.
4. Replace the single-slot `onStatusChange` (`packages/ui/src/topbar.ts:1101`) with a
   listener set, and capture the `onProtocolChainSync` unsubscribe currently discarded at
   `packages/ui/src/topbar.ts:1137`.
5. Add silence detection that rebuilds the client, since a frame reset notifies nobody.

Exit criteria: with the popover open on previewnet, bars accrue for every supported chain
at roughly the measured interval. Closing and reopening within the grace shows continuous
history, and reopening after it shows a gap. No more than 4 chain connections are held, and
none while the popover has never been opened.

### Phase 4: render it

Goal: the panel the request describes.

1. Rows labelled by purpose: Relay, General, Storage, Identity, iterating
   `getActiveChainRoles()` so a row, its bars and its sync state share one key.
2. Per-block bars, green to 1.5x expected, amber to 3x, red beyond, with the trailing bar
   coloured by time since the last block.
3. A live status dot and sentence derived from current bar state rather than a latched
   milestone verdict. Keep the words "Your connection is good" for the healthy case.
4. Make the table render under all three backends, replacing the two early returns. Where a
   chain cannot be reached, say why rather than showing `n/a`: Storage in gateway mode is
   served over the IPFS gateway, and `paseo-next-v1` has no endpoint for Storage or
   Identity.
5. Light theme overrides for every colour introduced. Text 4.5:1, bars 3:1 as non-text.

Exit criteria: opening the globe on previewnet in both themes shows four purpose-labelled
rows with live bars and a status line that changes when a chain degrades. Contrast measured,
not assumed. Verified on `smoldot-direct` and at least one other backend.

## Checklist

- [ ] Remove the 3s reveal gate — `packages/ui/src/ui.ts`, `packages/ui/src/styles/base.css` — done when the first sentence is in the first painted frame, measured in a browser
- [ ] Add a bar-stall detector with an exported subscription — `packages/ui/src/ui.ts` — done when a parked bar fires it and a moving bar does not
- [ ] Extend the warning facts with progress and add bar-stall copy — `apps/host/src/warnings.ts` — done when a parked bar produces a sentence quoting throughput or peers, and a healthy load produces none
- [ ] Wire the host to both stall sources — `apps/host/src/main.ts` — done when either cause renders through the one warning element
- [ ] Add `ChainRole`, `getActiveChainRoles`, `chainRoleForGenesis` — `packages/config/src/network.ts` — done when typecheck passes and the role record is exhaustive over `ChainKey`
- [ ] Add per-network `blockTimeMs`, Bulletin 6000 with a comment saying why — `packages/config/src/network.ts` — done when all four roles carry a value for both active networks
- [ ] Create the monitor with an injected follow factory — `packages/ui/src/network-monitor.ts` — done when synthetic events drive bars in a unit test
- [ ] Replace `onStatusChange` with a listener set and capture the chain-sync unsubscribe — `packages/ui/src/topbar.ts` — done when closing the popover leaves no live subscriber
- [ ] Add the 60s idle grace, `pagehide` teardown and silence detection — `packages/ui/src/network-monitor.ts` — done when no follow outlives the grace and a simulated frame reset rebuilds
- [ ] Render purpose-labelled rows from `getActiveChainRoles()` — `packages/ui/src/topbar.ts` — done when Relay, General, Storage, Identity each show their own bars
- [ ] Colour bars against per-chain expected time — `packages/ui/src/topbar.ts`, `packages/ui/src/styles/base.css` — done when Bulletin reads green at 6s and would read red at 2s thresholds
- [ ] Derive the status line from live bar state — `packages/ui/src/topbar.ts` — done when killing a chain's blocks changes the dot without a reload
- [ ] Render the table for gateway and shared-worker, with honest unavailability copy — `packages/ui/src/topbar.ts` — done when neither backend shows a bare `n/a`
- [ ] Light theme overrides and measured contrast — `packages/ui/src/styles/themes.css` — done when every new colour clears 4.5:1 for text and 3:1 for bars in both themes
- [ ] Unit tests for the monitor — `packages/ui/tests/network-monitor.test.ts` — done when colour boundaries, ring eviction, gaps and teardown are covered
- [ ] One functional spec opening the globe — `apps/host/tests/functional/` — done when it asserts four rows and at least one bar, outside `resolution.spec.ts`
