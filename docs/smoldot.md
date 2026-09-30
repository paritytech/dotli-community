---
summary: "Where smoldot lives in dotli, the chain set per origin, and the consumer pattern for cross-origin chain access"
read_when:
  - You need to read or subscribe to a chain from host shell or sandbox code
  - You are adding a new parachain to the protocol iframe's chain dispatcher
  - You are debugging a smoldot panic, bootnode error, or CPU long-task warning
  - You want the canonical map of which origin owns which smoldot client
title: "Smoldot"
---

dotli embeds the [smoldot](https://github.com/smol-dot/smoldot) Polkadot light client to read and write parachains directly from the browser. This page covers how smoldot is wired today, which chains it serves, and how application code should reach those chains.

## Where smoldot lives

The protocol iframe owns the resolver and sandbox-facing smoldot client. When
the host backend is set to Light Client, the host shell also starts a smoldot
client for Rust-core `chain.connect` requests.

| Origin | Purpose | Triggered by |
|---|---|---|
| Protocol iframe (`host.localhost`, production `paseo.li`) | Domain resolution (Asset Hub query to CID), chain RPC brokering, bitswap content fetching | `apps/protocol/src/main.ts` (direct/shared-worker submodes) and `apps/protocol/src/protocol-shared-worker.ts` |
| Host shell (user's destination domain, e.g. `foo.dot`) | Rust-core chain access for auth, product requests, and Bulletin submission when Light Client is selected | `packages/ui/src/host-callbacks/Chain.ts` |

Both origins use the singleton in `packages/resolver/src/provider.ts`,
backed by **`@parity/truapi-provider` 0.3.1**. RPC Gateway mode routes
requests to configured WebSocket endpoints instead.

## Provider contract

`createChainProvider(genesisHash)` adapts the provider's raw JSON-RPC
`Connection` to polkadot-api. It queues only while asynchronous initialization
and connection opening are pending. After connection, the provider itself holds
requests until the chain first syncs, then forwards them in order. Chain-spec,
statement-store, Bitswap, and lifecycle requests bypass that sync wait.

Held requests share the provider's 1024-frame connection budget. The adapter
continuously drains `nextResponse()`; budget refusals arrive as JSON-RPC errors,
not a closed connection. An unexpected end of the response stream is fatal.

The existing `lifecycle_unstable_follow` side channel remains active during sync.
Its snapshots count as watchdog proof even while `system_health` is held until
ready, so healthy sync progress does not report a broken loading-detail channel.

The optional `setConnectionTypes({ secure, localhost, unsecure })` API is not
used here: the upgrade preserves the existing connection policy and browser
restrictions rather than adding a new settings control.

## Chains

Five chain factories ship in `packages/resolver/src/smoldot.ts`.

| Function | Chain | Purpose | Genesis hash |
|---|---|---|---|
| `getRelayChain()` | Paseo relay | Required parent for the parachains below | `PASEO_RELAY_GENESIS` (`config.ts:83`) |
| `getDappAssetHubChain()` | Asset Hub Paseo | Domain resolution and product queries (single shared chain) | `ASSET_HUB_PASEO_GENESIS` (`config.ts:85`) |
| `getBulletinChain()` | Bulletin Paseo | Content reads and Rust-core preimage submission | active network config |
| `getPeopleChain()` | People | Statement-store auth | active network config |

There is exactly one Asset Hub chain (`getDappAssetHubChain()`, `smoldot.ts:519`), shared by the resolver and every dApp session through the `ChainBroker`. The broker opens a single follow that is never removed mid-read. The resolver reads through a local broker session (`broker.getLocalProvider(genesis)`, object-wire), and dApp connections attach as remote sessions on the same follow. This replaced the earlier resolver/product chain split. In that split the resolver's chain was released once the CID was cached, so the first dApp connection releasing that follow mid-read produced the `ChainHead disjointed` load failure.

`getActiveSupportedGenesisHashes()` contains the active network's relay, Asset
Hub, Bulletin, and People chains.

## Protocol modes

The protocol iframe parses a `?mode=` URL parameter (`apps/protocol/src/main.ts:318`) and dispatches at `main.ts:443-466`.

- `?mode=shared-worker` opens a `SharedWorker` (`apps/protocol/src/protocol-shared-worker.ts`). Smoldot runs in the worker thread.
- `?mode=direct` runs `initDirectMode()` (`main.ts:593`), which dynamic-imports the resolver and runs smoldot on the iframe main thread.
- `?mode=rpc` runs `initRpcMode()` (`main.ts:658`). No smoldot. Chain calls go to a trusted WSS JSON-RPC endpoint.

The host shell selects the submode from `chainBackend` at `apps/host/src/main.ts:366-371`.

## Talking to a chain

Sandbox-facing consumers use the cross-origin seam exposed by
`@dotli/protocol/client`. The host's Rust-core `chain.connect` callback is the
exception: it imports `@dotli/resolver/chains` and
`@dotli/resolver/rpc-chain` to honor the selected backend.

```ts
import { createRemoteChainProvider } from "@dotli/protocol/client";
import { ASSET_HUB_PASEO_GENESIS } from "@dotli/config/config";

const provider = createRemoteChainProvider(ASSET_HUB_PASEO_GENESIS);
if (provider === null) {
  throw new Error("Chain not in SUPPORTED_GENESIS_HASHES");
}
const client = createClient(provider); // polkadot-api
```

`createRemoteChainProvider(genesisHash)` (`packages/protocol/src/client.ts:619`) returns a polkadot-api `JsonRpcProvider` that bridges to the protocol iframe via `chainConnect` / `chainSend` / `chainDisconnect` postMessage envelopes. The protocol iframe's smoldot is the actual backend. Returns `null` if the genesis hash is not in `SUPPORTED_GENESIS_HASHES`.

Resolution helpers are pre-built: `resolveDotNameRemote(label)` and `resolveOwnerRemote(label)` at `client.ts:525` and `client.ts:537`. Call these instead of the resolver's local equivalents.

Bulletin preimage submission is built, signed, and submitted entirely by the Rust core (`truapi-server`), which routes its `TransactionStorage.store` traffic through the host `chain.connect` callback like any other chain access. The host only provides `PreimageHost.lookupPreimage` for content retrieval; it no longer builds or signs the transaction.

## Persistence

dotli supplies origin-scoped IndexedDB storage through `createSmoldotDb()` and
`ChainProviderBuilder.setStorage()`. Before connecting, it calls `loadDatabase()`
so the first chain add can resume from stored finalized state. Cache outcomes
remain observable through the existing sync reporting; a storage failure leaves
the chain starting from its bundled checkpoint.

## Failure modes

- **Smoldot panic.** The log callback (`smoldot.ts:122-127`) detects `"Smoldot has panicked"` and `"panicked at"` and broadcasts a fatal signal via `onSmoldotFatal`. The protocol iframe forwards `fatal` envelopes to the host client, which rejects every pending request. Recovery requires a reload.
- **Bootnode connection issues.** Patterns at `smoldot.ts:98-106` (`reset by remote`, `refused`, `closed`, `timeout`, `no longer reachable`, `handshake`, `all bootnodes`) trigger `onConnectionIssue` listeners. The UI surfaces these to the user.
- **CPU long-task warnings.** Smoldot's WASM warns when a single Rust `poll()` blocks the thread for at least 150ms (smoldot upstream `wasm-node/rust/src/platform.rs:167`). Format: `` The task named `add-chain-N` has occupied the CPU for an unreasonable amount of time (Xms). `` The `N` suffix comes from the spawned task name. How the counter is scoped (per-client vs. process-global) has not been verified, so do not infer correlations from `N` alone.
- **Cached chain promises.** Each `get*Chain()` factory caches its promise. On rejection the promise is nulled out so the next call retries. On `terminateSmoldot()` (`smoldot.ts:194`) every cached chain promise is cleared so a freshly-restarted smoldot doesn't hand back dead-chain handles.

## Owner-only APIs

These resolver-package exports are owner-only and must not be imported outside
`apps/protocol/`, except for the host chain callback described above:

- `smoldot.ts`: `getSmoldot`, `getSmoldotDirect`, `terminateSmoldot`, `onSmoldotFatal`, `onConnectionIssue`, `getRelayChain`, `getBulletinChain`, `getPeopleChain`, `getDappAssetHubChain`, `getDappAssetHubProvider`, `makeNonRemovingChain`, `getPeopleChainProvider`
- `chains.ts`: `createChainProvider`, `isChainSupported` (host chain callback only)
- `resolve.ts` re-exports of `getSmoldot`, `getSmoldotDirect`, `getRelayChain`, `onConnectionIssue` plus the chain-touching helpers `resolveDotName`, `resolveOwner`, `waitForAssetHubFinalized`, `destroyResolverClient`, and `setResolverAssetHubProvider` (the bootstrap seam that points the resolver's Asset Hub reads at the broker's local session)

## Adding a new chain

The provider resolves supported genesis hashes through its bundled catalogue,
including parachain relay wiring. Add chains to that catalogue and the active
network service configuration in `packages/config/src/network.ts`; merely adding
a local chain-spec JSON file does not register a chain with this adapter.

The 0.3.1 package includes refreshed Paseo and Previewnet relay checkpoints.
These apply to catalogue-backed light-client connections; stored finalized
state still takes precedence. This adapter does not call `addLightChain()` or
load external spec overrides. The legacy `VITE_SS_RELAY_CHAIN` setting is not
consumed by the provider. Runtime endpoint overrides apply to `rpc-gateway`,
not to the catalogue or its checkpoints; custom external specs and remote RPC
nodes are not refreshed by this package upgrade.

Previewnet also reset its four chain genesis hashes
([upstream #995](https://github.com/paritytech/host-rust-core/pull/995)).
The active network configuration tracks the 0.3.1 catalogue's relay, Asset Hub,
Bulletin, and People hashes; the previous hashes are no longer registered.
DotNS addresses, storage slots, network suffix, and endpoint settings are unchanged.

Qualification used the real 0.3.1 WASM through `createChainProvider()` in a
browser: Paseo returned its genesis before an earlier `system_health` request,
reported connecting/warp progress/ready through the existing side channel, and
then answered health with `isSyncing: false` and four peers. Resolver unit tests
and typechecking passed. Deployment backend and product qualification remains
separate from this provider-level check.
The Previewnet browser check returned the configured genesis hash and synchronized
health with a peer for all four chains. It does not qualify Previewnet product
publication or identity registration.

## Related

- [Resolution design](resolution-design.md). Cold-start latency distribution and the shared Asset Hub follow via the broker.
