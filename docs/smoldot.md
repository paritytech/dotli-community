---
summary: "Where smoldot lives in dotli, the chain set per origin, and the consumer pattern for cross-origin chain access"
read_when:
  - You need to read or subscribe to a chain from host shell code
  - You are making a new chain reachable through the protocol iframe
  - You are debugging a smoldot panic or CPU long-task warning
  - You want the canonical map of which origin owns which smoldot client
title: "Smoldot"
---

dotli embeds the [smoldot](https://github.com/smol-dot/smoldot) Polkadot light client to read and write parachains directly from the browser. This page covers how smoldot is wired today, which chains it serves, and how application code should reach those chains.

## Where smoldot lives

The only smoldot client runs in the protocol iframe, or in its SharedWorker when
the frame is in shared-worker mode. It serves the resolver, the host shell and
every product. The host shell runs no light client: when the
host backend is set to Light Client, its Rust-core `chain.connect` requests go
to the protocol iframe.

| Origin | Purpose | Triggered by |
|---|---|---|
| Protocol iframe (`localhost/p/`, production `paseo.li/p/`) | Domain resolution (Asset Hub query to CID), chain RPC brokering, bitswap content fetching | `apps/protocol/src/main.ts` (direct/shared-worker submodes) and `apps/protocol/src/protocolSharedWorker.ts` |
| Host shell (user's destination domain, e.g. `foo.dot`) | Rust-core chain access for auth, product requests, and Bulletin submission, over the protocol iframe when Light Client is selected | `apps/host/src/runtime/hostCallbacks/createChainConnect.ts` |

Both protocol submodes build their light client with `createLightClient` from
`packages/chains/src/createLightClient.ts`. RPC Gateway mode routes Rust-core
requests to configured WebSocket endpoints (`createCoreRpcChainProvider`) and
starts no light client.

## The light client

`createLightClient` in `packages/chains/src/createLightClient.ts` builds one light client per context over the smoldot that `@parity/truapi-provider` embeds. `createLightClientDeps` gives it its stored chain databases, its log level and its live gauge.

- The engine (`startTruapiProvider`) starts on the first chain the light client opens. Every first open waits on that one start, and a failed start is tried again by the next open.
- In the SharedWorker (`apps/protocol/src/protocolSharedWorker.ts`) smoldot runs on the worker thread, where the `Worker` constructor is unavailable. In direct mode (`initDirectMode` in `apps/protocol/src/main.ts`) it runs in the iframe.
- `startLightClientService` in `apps/protocol/src/startLightClientService.ts` opens the chain pool on the light client, watches the relay and Bulletin, and builds the name resolver. Both submodes start it, the SharedWorker through `startProtocolWorker`.

Its members are `createChainProvider`, `isChainSupported`, `status` and `subscribe`.

## Chains

The light client adds a chain from its genesis hash alone, through truapi-provider's bundled catalog. It serves the four chains of the active network, one per `ChainRole` (`packages/config/src/chainRoles.ts`).

| Role | Chain | Purpose | Genesis hash |
|---|---|---|---|
| `relay` | Relay | Required parent for the parachains below | `relay.genesis` of the network in `BUILTIN_NETWORK_SERVICES` |
| `assethub` | Asset Hub | Domain resolution and product queries (single shared chain) | `assethub.genesis` |
| `bulletin` | Bulletin | Content reads and Rust-core preimage submission | `bulletin.genesis` |
| `people` | People | Statement-store auth | `people.genesis` |

`BUILTIN_NETWORK_SERVICES` lives in `packages/config/src/networkServices.ts`, and `getChainRoleForGenesis` maps a genesis hash back to its role.

There is exactly one Asset Hub chain in the chain pool `startLightClientService` opens, used by the resolver and every dApp session through the pool. The resolver and each dApp session hold follows of their own on the pool's Asset Hub lanes, so one session leaving never ends another's follow. The resolver reads through a local broker session (`requireBrokerLocalProvider` over the pool's `getLocalProvider`), and dApp connections attach as remote sessions. This replaced the earlier resolver/product chain split. In that split the resolver's chain was released once the CID was cached, so the first dApp connection releasing that follow mid-read produced the `ChainHead disjointed` load failure.

`getActiveSupportedGenesisHashes()` contains the active network's relay, Asset
Hub, Bulletin, and People chains. `isChainSupported` in
`packages/chains/src/createLightClient.ts` checks a genesis hash against it.

## Protocol modes

The protocol iframe reads a `?mode=` URL parameter in `init()` (`apps/protocol/src/main.ts`), maps it to a backend with `getBackendOfFrameMode`, and dispatches in `startMode`.

- `?mode=shared-worker` opens a `SharedWorker` (`apps/protocol/src/protocolSharedWorker.ts`). Smoldot runs in the worker thread.
- `?mode=direct` runs `initDirectMode()`, which dynamic-imports the light client (`loadProvider`), the resolver and the light client service, and runs smoldot in the iframe.
- `?mode=rpc` runs `initRpcMode()`. No smoldot. Chain calls go to a trusted WSS JSON-RPC endpoint.

The host configures the frame with the backend at boot, and the frame names it in its URL as `mode`.

In direct mode the frame disposes its light client service and its engine once its page is hidden for good, on `pagehide` through `disposeOnPageHide` (`apps/protocol/src/disposeOnPageHide.ts`). In rpc mode it disposes its engine the same way. In shared-worker mode it closes its link to the worker the same way (`connectSharedWorker`), and the worker lets go of that tab's port while its light client stays up for the other tabs. A page kept in the back-forward cache keeps them.

## Talking to a chain

Code on the host page reaches the frame's chains through the cross-origin seam
exposed by `@dotli/protocol`. The host's Rust-core `chain.connect` callback
leases the host chain pool (`createHostChainPool`), which takes this seam on
the Light Client backends and the `@dotli/chains` RPC providers on RPC Gateway.

```ts
import { getProtocolClient } from "@dotli/protocol";
import { getActiveServicesConfig } from "@dotli/config";

const provider = getProtocolClient().chains.createProvider(getActiveServicesConfig().assethub.genesis);
if (provider === null) {
  throw new Error("The protocol frame cannot connect this chain");
}
const client = createClient(provider); // polkadot-api
```

`getProtocolClient().chains.createProvider(genesisHash)` returns a `RemoteChainProvider`, a polkadot-api JSON-RPC provider that bridges to the protocol iframe over the protocol schema's `chain.connect` subscription and `chain.send` request. The protocol iframe's smoldot is the actual backend. Returns `null` if `isRemoteChainConnectable` refuses the genesis hash, which on the Light Client backends means it is not in `getActiveSupportedGenesisHashes()`.

Resolution helpers are pre-built: `getProtocolClient().resolve.resolveDotName(label)` and `getProtocolClient().resolve.resolveOwner(label)`. Call these instead of the resolver's local equivalents.

Bulletin preimage submission is built, signed, and submitted entirely by the Rust core (`truapi-server`), which routes its `TransactionStorage.store` traffic through the host `chain.connect` callback like any other chain access. The host only provides `PreimageHost.lookupPreimage` for content retrieval. It no longer builds or signs the transaction.

## Persistence

dotli keeps each chain's smoldot database in its own IndexedDB database (`SMOLDOT_DB_NAME`, built by `createSmoldotDb` in `packages/chains/src/createSmoldotDb.ts`). The light client hands a chain its stored database before the chain's first add (`resumeFromStore`) and writes it as the chain finalizes. A failed read starts the chain from its checkpoint, which is slower but correct. `purgeWorkerCaches` deletes the database when the frame's settings say to skip the worker cache.

Pre-cutover host-side smoldot may have left an IndexedDB chain DB at the user's destination origin. Stale state from the deleted code path stays on disk until the user clears storage. There is no `dotli doctor` command for this today.

## Failure modes

- **Light client fatal.** A failed engine start, or a chain that fails before it connects, marks the light client fatal (`markFatal`). `subscribe` hears it as a `fatal` change, and `status()` keeps it, since it never clears. In direct mode the frame fails its boot with a `ProtocolFatalError`. In the SharedWorker `startProtocolWorker` ends every port's status with one. The host client rejects every pending request with it. Recovery requires a new frame. A connect past truapi-provider's connection cap halts only its chain and is not fatal.
- **CPU long-task warnings.** Smoldot's WASM warns when a single Rust `poll()` blocks the thread for at least 150ms (smoldot upstream `wasm-node/rust/src/platform.rs:167`). Format: `` The task named `add-chain-N` has occupied the CPU for an unreasonable amount of time (Xms). `` The `N` suffix comes from the spawned task name. How the counter is scoped (per-client vs. process-global) has not been verified, so do not infer correlations from `N` alone.
- **Chain halts.** smoldot never reconnects underneath its consumers. A chain whose read fails after it connected, or whose stream ends unasked, halts: its provider reports `disconnected` and then the halt through `ChainTransportHooks`.

## Owner-only APIs

These exports are owner-only and must not be imported outside `apps/protocol/`,
except for the host resolver described below:

- `@dotli/chains`: `createLightClient`, `createLightClientDeps`, and `loadProvider`, which loads them lazily.
- `@dotli/resolver`: `createDotnsResolver`, which the iframe and the SharedWorker build on the broker's local sessions through `startLightClientService`. The host builds one on its own chain pool for rpc-gateway (`loadRpcResolver` in `apps/host/src/main.ts`).

## Adding a new chain

Steps to make a parachain reachable through the protocol iframe on the Light Client backends. The sequence below is inferred from the existing layout (relay, Asset Hub, Bulletin, People), and has not been exercised end-to-end in this branch.

1. Check that truapi-provider's bundled catalog holds the chain, since the light client adds a chain from its genesis hash alone.
2. Add the chain's role to `ChainRole`, `CHAIN_ROLES` and `CHAIN_ROLE_LABELS` in `packages/config/src/chainRoles.ts`, and its service to `ServicesConfig` and `FixedServicesConfig` in `packages/config/src/types.ts`.
3. Give each network in `BUILTIN_NETWORK_SERVICES` (`packages/config/src/networkServices.ts`) the chain's `genesis`, and add it to `getActiveSupportedGenesisHashes` in `packages/config/src/activeNetwork.ts`.
4. Host page code calls `getProtocolClient().chains.createProvider(<your-genesis>)` from `@dotli/protocol`. Rust-core access uses the host `chain.connect` callback.

Step 3 makes a chain reachable from both the protocol broker and the host
callback. Skip it and `getProtocolClient().chains.createProvider` returns
`null`. The host's `chain.connect` callback refuses the chain first, with
`Unsupported smoldot chain`, and a frame that is asked anyway refuses it with
`Unsupported chain`.

RPC Gateway serves a chain only if it has `rpcs` endpoints and is listed in
`getActiveGatewayChains` and `getActiveCoreGatewayChains` in
`packages/config/src/activeNetwork.ts`.

## Related

- [Resolution design](resolution-design.md). Cold-start latency distribution.
