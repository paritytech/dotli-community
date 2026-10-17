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
- The iframe serves through one serving transport on a window provider that admits only its parent at an allowed origin.
  It sends nothing unsolicited: its readiness and failures reach the host as events on the frame status subscription,
  which a late subscriber hears on subscribe. A handler's failure is answered as an error response.
- One engine dispatches for every mode. A scope holds one tab's chain connections and budget, while the chains are
  shared by every scope of the engine.
- Two handlers serve the shared stores and the local wallet under the shared-auth trust boundary: host and landing
  origins only, never product origins.
- In shared-worker mode the iframe serves the store and wallet methods itself and relays the others to the SharedWorker
  through its own consumer transport, including the frame status and telemetry subscriptions.
- The SharedWorker runs smoldot and serves each tab port with its own serving transport and engine scope, so no buffer
  is shared between ports. It drives the heartbeat: it sends a beat event to each port on its own clock, the iframe
  answers each with a heartbeat request, and a port that misses too many beats is released. A release ends that port's
  subscriptions with an error, so a thawed tab rebuilds its frame and opens a new port. A released port stays open, so a
  frozen tab still hears its release when it thaws, until its tab sends anything or the worker closes. A tab that leaves
  ends its subscriptions, which frees its connections at once.
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
