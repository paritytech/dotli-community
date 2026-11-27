# `@dotli/chains`

## Overview

Connects to the chains dotli reads. Holds the in-browser light client and the gateway providers. Also holds the chain
pool.

## Responsibilities

- **Owns** the smoldot light client and its saved database. It also owns the client's sync reporting.
- **Owns** the gateway mode providers over trusted RPC nodes.
- **Owns** the chain pool and what it runs on:
  - its lanes
  - its JSON-RPC broker
  - the watch guard
- **Owns** the byte meter for the chains' inbound traffic, and the error a halted chain answers with.
- **Does not own** what is read over a chain, or the connections the host reaches through the protocol frame.

## Public API

### `@dotli/chains`

| Export                                                                                      | What it does                       |
| ------------------------------------------------------------------------------------------- | ---------------------------------- |
| `createLightClient`, `createLightClientDeps`, `LightClient`, `LightClientDeps`              | The context's light client.        |
| `LightClientStatus`, `LightClientChange`, `SmoldotDbChain`, `SmoldotDbOutcome`              | Its state and database outcomes.   |
| `SMOLDOT_DB_NAME`                                                                           | Its saved database's name.         |
| `chainSync`, `ChainDetail`, `ChainPeer`, `ChainSyncEvent`, `ChainSyncKind`                  | Sync reporting.                    |
| `byteMeter`                                                                                 | Inbound byte count.                |
| `createCoreRpcChainTransport`, `isCoreRpcChainSupported`, `getConnectedAssetHubRpcEndpoint` | Gateway chains.                    |
| `ChainTransport`, `ChainTransportHooks`, `ConnectionStatus`, `RPC_FOLLOW_LIMIT`             | Transport types and follow limit.  |
| `createChainPool`, `ChainPool`, `ChainPoolControl`, `ChainPoolWatcher`, `ChainActivity`     | The chain pool.                    |
| `StringJsonRpcConnection`                                                                   | A remote session on the pool.      |
| `requireBrokerLocalProvider`                                                                | A provider leased from the broker. |
| `ChainHaltError`, `getHaltReason`, `RemoteChainHalt`, `createChainHaltedError`              | Chain halts.                       |
| `createJsonRpcError`                                                                        | Every transport's error answer.    |
| `loadProvider`                                                                              | Lazy loader of the light client.   |

### `@dotli/chains/testing`

`FakeWebSocket`: a WebSocket fake for tests.

## Design

```mermaid
flowchart LR
  subgraph lane[per lane]
    broker[broker session] --> guard[watch guard] --> pausing[pausing wrapper] --> transport
  end
  consumer --> pool[chain pool] --> lanes[chain lanes] --> router[lane router] --> broker
  transport --> lc["light client: smoldot, saved database"] --> peers
  transport --> gw["gateway provider: WebSocket, replay"] --> rpc[trusted RPC node]
  lc -. lifecycle snapshots .-> sync[sync reporting]
```

- **Light client:** one per context. It runs the chains of the active network's signed stack, which its deps load, and
  never the engine's bundled catalog. Its database is saved per genesis hash, so a repeat visit skips the checkpoint
  sync.
- **Engine start:** opens the copy of the stack its deps read, the stored one first, with no wait on the network. Each
  light spec the descriptor names comes from the specs kept from an earlier start, by its SHA-256, else from the
  network, retried. Once the engine accepted every spec, the set is kept for the next start. A spec the engine refuses
  means the copy went stale, so the start waits for the newer copy its deps fetch and runs again from it. A spec that
  still cannot be had, or a refusal with no newer copy, fails the start, and the light client turns fatal.
- **Spec refresh:** when a newer copy arrives after a start from an older one, its specs are fetched and checked on an
  engine builder that is freed afterwards. They are kept for the next start, while the running engine keeps its copy. A
  failure here is reported and fails nothing.
- **Copy kept on acceptance:** the deps store a fetched copy only when the start keeps it, whether the start opened it
  or it is the newer copy. The start keeps it once the engine took it and its specs are kept: after the start, after a
  spec refresh or after a start again from it. A refused copy and a refresh that fails keep nothing, so the next start
  opens the copy whose specs it holds.
- **Gateway providers:** reconnect and replay subscriptions. They never import smoldot.
- **Pool:** each lease is a consumer. A chain closes after its last lease, or at once when it halts. Watchers hear each
  change once the call that made it has returned, so one that asks the pool for a chain finds the pool settled.
- **Healing:** a local lease takes the rebuilt chain after a halt. A remote session ends and hears why.
- **Lanes:** each lane is one connection. Follows spread across lanes to stay under the transport's follow limit. A halt
  of any lane halts the chain. A chain reads connected while any lane is, and connecting only while none is and one
  opens.
- **Pause:** closes every connection and keeps every lease. Sessions above stay connected.
- **Broker:** shares one connection between JSON-RPC sessions. Each session owns its own upstream follow. A halt is
  final.
- **Watch guard:** ends transaction watches a disconnect drops, so a replay never resubmits them.
- **Byte meter:** wraps the socket constructors, since resource timing misses WebSocket and WebRTC. Install it before
  any socket opens.
- **Lazy loading:** the light client is heavy and loads through `loadProvider`. The entry is pure re-exports.
- **Fixed config only:** the light client and sync reporting also run in a worker, so they read only the fixed services
  config. Lint enforces it.
- **Halt modules** import nothing that loads the pool, so an eager client can take them.
