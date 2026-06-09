# Debug panel

The debug panel is a docked overlay that aggregates host-side activity
from three independent event sources into one time-aligned inspector.
It's gated as `EXPERIMENTAL` because the SDK hooks it consumes aren't
a stable public surface yet.

The panel ships in every build. In dev environments
(`VITE_APP_DEBUG=true`) it auto-mounts collapsed; in staging/prod it
stays off until enabled via the Settings panel's "Open in debug mode"
button or `?debug=true`. Its heavy chunk is dynamically imported, so
users who never see the panel pay zero download cost.

---

## Table of contents

- [What you see](#what-you-see)
- [Enabling and disabling](#enabling-and-disabling)
- [The three event sources](#the-three-event-sources)
- [Views](#views)
  - [List view](#list-view)
  - [Timeline view](#timeline-view)
- [Filters](#filters)
- [Detail pane](#detail-pane)
- [Design concepts](#design-concepts)
  - [Correlation keys](#correlation-keys)
  - [Flows, boxes, pills](#flows-boxes-pills)
  - [Swimlanes](#swimlanes)
  - [Early-event buffer](#early-event-buffer)
  - [Keyed reconciliation](#keyed-reconciliation)
- [What's intentionally NOT instrumented](#whats-intentionally-not-instrumented)
- [Adding a new hook](#adding-a-new-hook)
- [Known limitations](#known-limitations)

---

## What you see

A resizable, dockable panel at the bottom of the viewport. It mounts
visible whenever debug mode is on; the panel's `×` button exits debug
mode entirely (see [Enabling and disabling](#enabling-and-disabling)).
The left pane is your choice of **List** or **Timeline**; the right
pane is the detail inspector for the selected event. A draggable
splitter between them lets you rebalance the panes.

Hover any element in the Timeline for a zero-delay tooltip with the
decoded method + summary. Click any row or box to pin it in the
detail pane.

## Enabling and disabling

The panel ships in every build. Default behavior depends on the build
flag `VITE_APP_DEBUG`:

- **Dev environments** (`VITE_APP_DEBUG=true`: `bun run preview:debug`
  locally, `paseoli.dev` and `dotli.dev` in CI via the `APP_DEBUG`
  GitHub Environment secret): the panel auto-mounts **collapsed**
  (header-only) so it's a one-click expand away without covering
  content unsolicited.
- **Staging / production** (`VITE_APP_DEBUG` unset): the panel is off
  until the user explicitly opts in.

When the panel isn't mounted, the bus stays in a null-stub state and
every `emitDotliDebugEvent(...)` call site scattered through `main.ts`,
`bridge.ts`, and `container.ts` is a cheap early-return. The panel's
UI chunk (`panel-*.js`) is a dynamic import — it isn't fetched until
the panel mounts.

Two ways to explicitly turn the panel on (mounts **expanded**):

1. **Settings button:** click **Open in debug mode** at the bottom of
   the host Settings menu (below "Share diagnostic"). The button
   reloads the current tab with `?debug=true` appended.
2. **URL param:** visit any page with `?debug=true`. The flag is
   persisted to `sessionStorage` and stripped from the URL (so it
   doesn't leak into the sandbox iframe's strict param validator).

Explicit opt-ins win over the build-time default — once you've toggled
within a tab, the persisted choice survives reloads until the tab
closes or you toggle the other way.

To turn it off:

- Click **Exit debug mode** in the host Settings menu — same row as
  "Open in debug mode" (the button toggles based on current state).
- Click the `×` button on the panel header. Both paths set
  `sessionStorage["dotli:truapi-debug"]` to `"0"` and reload, which
  fully exits debug mode and discards the in-memory event store.
- Visit any page with `?debug=off`. Also persisted + URL-stripped.
- Close the tab — the choice is sessionStorage-scoped, so a fresh
  tab starts clean regardless.

## The three event sources

Every event observed by the panel comes from one of three buses. Each
bus is independent; the panel merges their streams into one time-
aligned store.

### 1. TrUAPI — host ↔ product messages

The postMessage protocol between the dotli host and product iframes,
captured by `onHostApiDebugMessage` from `@novasamatech/host-container`.
Every message is already decoded (no SCALE bytes). Categories:

- `host_*` — accounts, signing, scoped storage, chain connections,
  statement-store proxying, preimage submission, permissions prompts,
  push notifications.
- `remote_chain_*` — chainHead, chainSpec, and transaction methods
  (one-to-one wrap of the new Substrate JSON-RPC spec).
- Many more — anything in the `HostApiProtocol` enum.

### 2. host-papp — SSO / attestation / session

Semantic protocol flows that sit above the statement-store transport,
captured by `onHostPappDebugMessage` from `@novasamatech/host-papp/debug`.

- `sso:*` — QR-code pairing flow (`pairing_started`,
  `deeplink_generated`, `awaiting_response`, `response_received`,
  `session_established`, `pairing_failed`).
- `attestation:*` — on-chain guest identity registration
  (`started`, `username_claimed`, `allowance_granted`,
  `vrf_proof_generated`, `person_registered`, `completed`, `failed`).
- `session:*` — post-pairing wallet ↔ host messages in both
  directions (`peer_action_received/processed/failed`,
  `host_action_sent/response_received/failed`, plus `opened` and
  `terminated`).

### 3. dotli — boot / resolve / render / bridge / failover

Dotli-internal host-side orchestration, captured by
`onDotliDebugEvent` from `@dotli/truapi-debug/dotli-debug-bus`.

- `boot:*` — `started`, `protocol_warmup_started`, `topbar_ready`,
  `url_parsed`, `cid_cache_checked`, `landing_page_shown`, `ready`,
  `failed`.
- `resolve:*` — `started`, `phase`, `storage_read`, `completed`,
  `failed`.
- `render:*` — `iframe_begin`, `iframe_ready`.
- `bridge:*` — `setup_begin`, `setup_ready`, `nested_detected`.
- `failover:*` — `chain_backend` (user-triggered backend switch).

## Views

Both views operate on the same filtered slice of the event store.
Clicking an event in one view pins the same event in the detail
pane regardless of which view is active.

### List view

A chronological row per event. Each row shows:

- Wall-clock timestamp (HH:MM:SS.mmm).
- Direction arrow (▶ outgoing, ◀ incoming) for TrUAPI; a layer badge
  (`boot`, `resolve`, `sso`, …) for system events.
- Product id (for TrUAPI) or a flow-id badge (for system) — both
  tinted by a stable hash of the id, so rows belonging to the same
  request / flow share a colour.
- Method tag or `layer.event` identifier, color-coded by category
  (request / response / receive / system).
- Inline summary — either decoded chain annotations (block hash,
  opId tail, outcome) or the system-event one-liner.
- Delta from the group's first event (e.g. RTT on a response, time-
  since-start on a subscription receive).

Under heavy traffic the list renders incrementally — new rows are
appended without rebuilding existing DOM, so clicks on older rows
stay responsive while events stream in.

### Timeline view

A 2-D layout with time on the Y axis (top = earlier, newest at the
bottom). Events are grouped into vertical **swimlanes** and lane-
packed within each swimlane: a new box occupies the leftmost lane
that isn't already taken at its Y range.

Each swimlane has its own horizontal scroll, so a chain with many
concurrent operations can grow wide without pushing the whole view.
Vertical scroll is shared across all swimlanes, so events at the
same Y in different swimlanes occurred at the same moment.

## Filters

The filter bar at the top of the panel applies to both views:

- **TrUAPI / System checkboxes** — coarse kind toggle. Unchecking
  hides events of that kind from both views, and the affected
  swimlanes disappear when they have nothing to show.
- **Direction chips** (both / out / in) — TrUAPI-only; system events
  are shown regardless.
- **Product chips** — one per distinct `productId` seen; TrUAPI-only.
- **Tag filter** — case-insensitive substring match. Matches against
  the TrUAPI method tag for TrUAPI events, and against
  `layer:event` for system events.

Pause / Clear buttons are in the panel header:

- **Pause** — stops ingesting new events. Already-stored events stay
  visible; resume to start ingesting again.
- **Clear** — drops the ring buffer. The selected-event detail
  resets to "(select an event to inspect)".

## Detail pane

Click any row, box, or pill to pin it. The detail pane shows:

### For TrUAPI events

- **Core metadata**: time, direction, product, TrUAPI method tag,
  requestId, flow/group size.
- **Sibling pills** (List view only) — every other event sharing the
  same `requestId`, with delta times. Click to jump.
- **Summary** — a human-readable one-liner describing what the
  chain-protocol message means (decoded from the JSON-RPC shape).
- **Chain annotations** — the correlation keys that are buried
  inside the payload: `genesisHash`, `followSubscriptionId`,
  `operationId`, `blockHash`, event tag, outcome.
- **Full payload JSON**, pretty-printed with Uint8Array values
  rendered as hex.

### For system events

- **Core metadata**: time, source (`host-papp` or `dotli`), layer,
  event, flowId.
- **Summary** — the short sentence from `system-summary.ts`.
- **"What is this?"** — a collapsible `<details>` block with a
  long-form paragraph explaining what the subsystem is doing at
  this point, what triggered the event, and what it unblocks
  downstream. One entry per event variant
  (see `packages/truapi-debug/src/system-explanations.ts`).
- **Full payload JSON**.

### Timeline view: group display

When a box is clicked in Timeline view, the detail pane stacks every
member of the box's group chronologically. Each member has its own
Summary, "What is this?", and payload JSON. This is useful for long
flows (an SSO pairing, a chainHead.body that streamed N result
events through its follow subscription): you see the whole sequence
in one glance.

## Design concepts

### Correlation keys

Every event in the store has a correlation key, used for grouping:

- **TrUAPI events** key on `requestId` — the same id that the
  transport uses to correlate requests with responses or to stream
  receives on a subscription.
- **System events** key on `flowId` — a uuid generated by the emit
  site at the start of a flow. Every event in the same flow shares
  the flowId. Host-originated session actions use their per-action
  `messageId` as the flowId so each action is its own mini-flow.

`eventsInGroup(key)` and `firstInGroup(key)` query the store
uniformly regardless of the key's origin.

### Flows, boxes, pills

In the Timeline:

- A **box** represents a flow that has (or will have) a clear
  beginning and end. Examples: a TrUAPI request → response pair, a
  chainHead.body operation from request → terminal event on its
  follow subscription, a whole SSO pairing flow, an attestation
  sequence.
- A **pill** represents a point-in-time event with no natural end —
  `failover:chain_backend`, `bridge:nested_detected`, and single-
  event system flows.
- **Pending boxes** have a dashed bottom edge. They grow downward
  as time advances; once the terminal event lands, the box snaps to
  its final height.

The mapping from event to box is encoded in `timeline-layout.ts`:
`segmentForGroup` for TrUAPI, `systemSegmentForGroup` for system
events. Subscriptions that aren't request-response-shaped (e.g.
`chainHead.follow`) are drawn as **rails** — thin vertical lines in
their own left-edge column — not boxes.

### Swimlanes

- **Chain swimlanes** — one per distinct `genesisHash` observed
  among TrUAPI chain messages. The swimlane only appears once a
  `remote_chain_head_follow_start` has been observed for that chain
  (otherwise it'd clutter the view with one-off queries). The
  header shows the chain's friendly name when known (Paseo, Paseo
  Asset Hub, Paseo Bulletin) or a short hex hash otherwise.
- **System swimlane** — everything from the `host-papp` and `dotli`
  buses. Always present if any system event is visible.
- **Other swimlane** — TrUAPI traffic that isn't chain-related
  (host API calls for signing, storage, accounts, statement store,
  etc.).

Swimlane order: chain swimlanes first (alphabetical by genesis),
then System, then Other.

### Early-event buffer

Boot events fire in `main()` within the first few milliseconds of
page load. The panel itself is a dynamic import that might take
tens of hundreds of ms to resolve, during which the bus has no
listener.

To avoid dropping those early events, the dotli bus supports an
opt-in buffer. `main.ts` calls `enableDotliDebugBuffering()` as
soon as it knows the panel will be loaded, before the first emit.
Events emitted during the panel's load window are retained in a
bounded ring (capacity 512); the first subscriber triggers a
one-shot replay. After replay, buffering switches off and
subsequent no-listener emits go back to being silent no-ops.

This makes the captured boot sequence consistent regardless of
browser cache warmth.

The TrUAPI hook and the host-papp hook don't need the same
mechanism in practice: TrUAPI traffic can't start before a product
iframe is rendered (long after the panel is up), and SSO flows only
begin on user interaction.

### Keyed reconciliation

Both the list and the timeline renderers avoid `innerHTML =` on
steady-state updates. Every logical element (row, box, rail, tick,
label, connector) carries a `data-key` derived from its stable id
(event seq, segment anchor, etc.). On each render we walk the new
layout and either update an existing element's attributes in place
or create it if it didn't exist; elements whose key is absent from
the new layout are removed.

This keeps hover state stable and means clicks don't get dropped
between pointerdown and click when events are streaming in — the
earlier bug class where `<details>` expansion and timeline-box
selection were flaky under heavy traffic.

The detail pane is rebuilt only on user-initiated events (clicks,
tab swap, filter change, clear). Incoming events don't touch it,
so the `<details>` expand-collapse interaction is always stable.

## What's intentionally NOT instrumented

The design rule: hook places where independent decision-making logic
lives. Skip layers that just translate or forward messages from a
layer already being observed.

- **`host-substrate-chain-connection` (WS provider, BranchedProvider,
  metadata cache).** Pure translation of `remote_chain_*` TrUAPI
  calls into JSON-RPC over WebSocket. The TrUAPI hook already shows
  the semantic shape; the JSON-RPC layer is just the wire format.
- **statement-store transport** (encrypt/decrypt, RPC adapter,
  subscription multiplexer). Pure transport for SSO / session
  messages; the SSO / session hooks capture the semantic protocol
  on top.
- **smoldot internals** (raw log callback stream). Dependency
  chatter, not host logic. The resolver's decision outcomes are
  captured instead.
- **host-container raw iframe postMessage**. Encoded form of TrUAPI
  messages already observed in decoded form.
- **handoff-service file chunking**. Transfer transport, not
  semantic protocol.
- **Bulletin preimage submission**. Direct forward of the TrUAPI
  `remote_preimage_submit` request.

If any of these become useful to observe in practice, they can be
added without restructuring anything: each hook is an independent
bus and the panel subscribes to all of them.

## Adding a new hook

1. **Pick the right bus.** If the event originates in the SDK
   (host-api / host-container / host-papp / statement-store), it
   belongs in the SDK's bus (and needs an upstream release in
   `@novasamatech/*`). If it originates in dotli, use the dotli bus.
2. **Add an event type.** Extend the relevant discriminated union
   (`DotliDebugEvent`, `HostPappDebugEvent`) with a new variant
   carrying `layer`, `event`, `flowId`, `timestamp`, and a typed
   `payload`.
3. **Add a summary.** Extend `system-summary.ts` (one-liner) and
   `system-explanations.ts` (long-form "What is this?").
4. **Add a flow terminator if needed.** If the new event closes a
   multi-step flow, add its suffix to `SYSTEM_TERMINATOR_SUFFIXES`
   in `timeline-layout.ts` so pending-vs-complete is computed right.
5. **Emit.** Call `emitDotliDebugEvent(...)` or
   `emitHostPappDebugMessage(...)` at the decision point. Check
   `hasDotliDebugListeners()` first if payload construction is
   expensive.

No UI changes required — the filters, swimlanes, and detail pane
pick up new variants automatically.

## Known limitations

- **Ring buffer is fixed at 2000 events.** Large enough for most
  interactive debugging, but a long-running session that generates
  lots of `NewBlock` / `BestBlockChanged` ticks will evict older
  events. A future iteration could expose capacity as a setting or
  add a "pause when full" mode.
- **No time-based Y scale yet.** Timeline Y is event-index-based
  (each event = fixed `ROW_HEIGHT` pixels), not wall-clock-based.
  Works well for dense bursts but doesn't preserve idle-period
  relative sizing. A proper time scale is a follow-up.
- **Timeline keyboard navigation is list-only right now.** ↑/↓ step
  through the list; there's no equivalent in Timeline view yet.
- **No export / import.** Captured events are tab-local and
  discarded on reload.
