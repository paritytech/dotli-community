# `@dotli/protocol-app`

The hidden protocol iframe that holds the light client and answers the host's requests. It is the one place that talks
to the network on the host's behalf. See the root [README](../../README.md) for the product as a whole.

## Responsibility

- Run smoldot (or a trusted RPC gateway) and resolve names, chain requests and block fetches for host pages.
- Serve the shared auth, mode and local wallet stores to host and landing origins of the root domain.
- Share one light client across tabs through a SharedWorker in shared-worker mode.
- Not the protocol types, the chain pool, the light client, the gateway providers or the resolution logic. The frame
  wires them, it does not own them.

## Design

- The `?mode=` query picks smoldot in a cross-tab SharedWorker, smoldot in the iframe, or trusted WSS RPC for gateway
  mode. Each chain mode loads its chains on demand, so the shared-worker mode, which only relays, loads none. The byte
  meter is installed where the light client runs, in the iframe or the SharedWorker, before it starts, and either one
  posts the light client's byte total for the host's speed readout. Startup reports failures to the parent without a
  reload.
- One ticker reads the byte meter for every telemetry subscription where the light client runs, started by the first and
  stopped with the last. Each subscriber hears the total at once as its baseline. A subscribe whose first read or ticker
  start fails leaves nothing behind. A read that fails on a tick is skipped and reported once per run of failures, under
  its own metric, and a subscriber that throws is reported without stopping the others.
- The iframe serves through one serving transport on a window provider that admits only its parent at an allowed origin.
  Bytes from a page at any other origin are refused, and the first from each such origin is counted as a refused wire
  message and logged, so a hostile page that keeps posting floods neither. Objects from the parent come only from a host
  page of an earlier release, and are counted as not bytes.
- It sends nothing unsolicited: its readiness and failures reach the host as events on the frame status subscription,
  which a late subscriber hears on subscribe. The status tells each subscriber on its own, so one that throws is
  reported and the others still hear. A handler's failure is answered as an error response.
- The frame's boot holds the status and the telemetry together, since the host subscribes to both as soon as its
  handshake is answered, before the mode has loaded anything. A chain mode feeds the telemetry from its light client.
  Auth-only and gateway mode run none, so once ready they serve an idle feed that stays open and says nothing. A boot
  that fails, or a fatal asset load, ends the status and any telemetry still waiting with that error. A ready frame that
  dies later keeps its telemetry.
- One engine dispatches for every mode. A scope holds one tab's chain connections and budget, while the chains are
  shared by every scope of the engine. A chain send needs a connection id. A name read whose result or end cannot be
  sent to the host is reported, and a result that cannot be sent ends the read with that error, so the host does not
  wait.
- Two handlers serve the shared stores and the local wallet under the shared-auth trust boundary: host and landing
  origins only, never product origins. The iframe's provider already admits no other origin, so the handlers' own check
  holds the boundary on any transport they are served over. What the stores refuse is counted as bad input, and what the
  wallet refuses is logged.
- In shared-worker mode the iframe serves the store and wallet methods itself and relays the others to the SharedWorker
  through its own consumer transport, including the frame status and telemetry subscriptions.
- The SharedWorker runs smoldot and serves each tab port with its own serving transport and engine scope, so no buffer
  is shared between ports. It drives the heartbeat: it sends a beat event to each port on its own clock, the iframe
  answers each with a heartbeat request, and a port that misses too many beats is released. A release ends that port's
  subscriptions with an error, so a thawed tab rebuilds its frame and opens a new port. A released port stays open, so a
  frozen tab still hears its release when it thaws. It closes on the beat after its tab speaks again, so the ends posted
  at the release arrive first, or when the worker closes.
- A tab that leaves ends its subscriptions, which frees its connections at once. Its port is then forgotten and closed
  at once, since a live tab always holds a subscription and one that drops to none through its own unsubscribe, with no
  call in flight, has disposed its transport. A port whose tab crashed fires its close event, and the worker forgets it,
  or closes it if it was released, at once. Where an engine never fires the event, the heartbeat release is the
  fallback.
- The iframe's link to the worker waits for the worker to be ready, and answers its beats until the worker's status
  ends. A ready wait that fails, by timeout, a worker that fails to load or one that reports a failure, disposes the
  link's transport with that error, so the status subscription, the beats and the relay let go of the worker. The
  timeout and the load failure are init failures.
- A fatal light client ends every port's frame status with the error, and a port that connects later hears it on
  subscribe. The worker closes once every connected port has heard it.
- One setup starts the light client's chains, the idle leases that let the relay and Bulletin sync be watched, a watcher
  that takes a halted chain again after a short wait, and the name resolver, for the iframe and the SharedWorker alike.
  Each keeps its own transport. Both build the telemetry they send the host with one typed builder, so a change to the
  wire contract fails the build in both. Tester knobs come from session storage and never block startup.
- The worker core may read only the fixed services config, because the runtime network config never reaches a worker
  that serves every tab. Lint enforces it.

```mermaid
flowchart LR
  host[host page] -- postMessage --> serving[serving transport]
  serving --> stores["shared stores, local wallet"]
  serving --> engine --> pool[chain pool]
  pool --> smoldot["smoldot, in the iframe or a SharedWorker"]
  pool --> gateway[WSS gateway]
```

## Entry points

- The iframe page. Dev server on port 4323.
- The SharedWorker.
- `npm run dev`, `build`, `build:prod`, `typecheck`, `lint`, `test`.
