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

The protocol runtime owns every physical smoldot client. Host code, including
the Rust Core chain callback, opens logical connections through
`connectChain()` and cannot construct a smoldot provider directly.

| Origin | Purpose | Triggered by |
|---|---|---|
| Protocol iframe (`host.localhost`, production `paseo.li`) | Direct-mode smoldot, RPC brokering, and the People provider used by SharedWorker mode | `apps/protocol/src/main.ts` |
| Protocol SharedWorker | Cross-tab smoldot and brokering for Asset Hub, Bulletin, and relay-chain connections | `apps/protocol/src/protocol-shared-worker.ts` |

Both protocol contexts construct smoldot through their realm-local singleton
in `packages/resolver/src/smoldot.ts`. RPC Gateway mode uses configured
WebSocket endpoints and does not start smoldot.

## Smoldot factories

Two client factories live in `packages/resolver/src/smoldot.ts`:

- `getSmoldot()` calls `startFromWorker(new SmWorker(), …)`. Smoldot runs in a dedicated Web Worker while its browser networking frontend remains in the protocol iframe.
- `getSmoldotDirect()` calls `start(…)`. Smoldot runs on the calling thread. It is used inside the SharedWorker, where the `Worker` constructor is unavailable.

Both share the same `smoldotInstance` cell within a JavaScript realm. Calling
either returns the existing client if one is already constructed.

## Chains

Four chain factories ship in `packages/resolver/src/smoldot.ts`.

| Function | Chain | Purpose | Genesis hash |
|---|---|---|---|
| `getDappAssetHubChain()` | Asset Hub Paseo | Domain resolution and product queries (single shared chain) | `ASSET_HUB_PASEO_GENESIS` (`config.ts:85`) |
| `getBulletinChain()` | Bulletin Paseo | Content reads and Rust-core preimage submission | active network config |
| `getPeopleChain()` | People | Statement-store auth | active network config |
| `getRelayChain()` | Paseo relay | Required parent for the parachains above | `PASEO_RELAY_GENESIS` (`config.ts:83`) |

There is exactly one Asset Hub chain (`getDappAssetHubChain()`, `smoldot.ts:519`), shared by the resolver and every dApp session through the `ChainBroker`. The broker opens a single follow that is never removed mid-read. The resolver reads through a local broker session (`broker.getLocalProvider(genesis)`, object-wire), and dApp connections attach as remote sessions on the same follow. This replaced the earlier resolver/product chain split. In that split the resolver's chain was released once the CID was cached, so the first dApp connection releasing that follow mid-read produced the `ChainHead disjointed` load failure.

`getActiveSupportedGenesisHashes()` contains the active network's relay, Asset
Hub, Bulletin, and People chains.

## Protocol modes

The protocol iframe parses a `?mode=` URL parameter (`apps/protocol/src/main.ts:318`) and dispatches at `main.ts:443-466`.

- `?mode=shared-worker` opens a `SharedWorker` (`apps/protocol/src/protocol-shared-worker.ts`). Asset Hub, Bulletin, and relay-chain providers run there and can be shared across tabs. People runs in the protocol iframe because `RTCPeerConnection` is unavailable in `SharedWorkerGlobalScope`; chain sync can succeed over WSS while Statement Store peer discovery still needs WebRTC.
- `?mode=direct` runs `initDirectMode()` (`main.ts:593`), which dynamic-imports the resolver and runs smoldot on the iframe main thread.
- `?mode=rpc` runs `initRpcMode()` (`main.ts:658`). No smoldot. Chain calls go to a trusted WSS JSON-RPC endpoint.

The host shell selects the submode from `chainBackend` at `apps/host/src/main.ts:366-371`.

## Talking to a chain

Every host consumer uses the cross-origin seam exposed by
`@dotli/protocol/client`.

```ts
import { createRemoteChainProvider } from "@dotli/protocol/client";
import { ASSET_HUB_PASEO_GENESIS } from "@dotli/config/config";

const provider = createRemoteChainProvider(ASSET_HUB_PASEO_GENESIS);
const client = createClient(provider); // polkadot-api
```

`connectChain(genesisHash)` (`packages/protocol/src/client.ts`) opens an asynchronous string-wire connection through the protocol iframe via `chainConnect` / `chainSend` / `chainDisconnect` envelopes. The protocol iframe or SharedWorker owns the broker and physical upstream provider. Rust Core's host callback uses this API directly.

`createRemoteChainProvider(genesisHash)` is the PAPI compatibility adapter over `connectChain()`. It converts PAPI's synchronous object-wire provider contract to the asynchronous string-wire connection without creating another broker or physical provider.

Resolution helpers are pre-built: `resolveDotNameRemote(label)` and `resolveOwnerRemote(label)` at `client.ts:525` and `client.ts:537`. Call these instead of the resolver's local equivalents.

Bulletin preimage submission is built, signed, and submitted entirely by the Rust core (`truapi-server`), which routes its `TransactionStorage.store` traffic through the host `chain.connect` callback like any other chain access. The host only provides `PreimageHost.lookupPreimage` for content retrieval; it no longer builds or signs the transaction.

## Persistence

dotli periodically extracts smoldot chain databases and persists them to
IndexedDB through `packages/resolver/src/smoldot-db.ts`.

Pre-cutover host-side smoldot may have left an IndexedDB chain DB at the user's destination origin. Stale state from the deleted code path stays on disk until the user clears storage. There is no `dotli doctor` command for this today.

## Failure modes

- **Smoldot panic.** The log callback (`smoldot.ts:122-127`) detects `"Smoldot has panicked"` and `"panicked at"` and broadcasts a fatal signal via `onSmoldotFatal`. The protocol iframe forwards `fatal` envelopes to the host client, which rejects every pending request. Recovery requires a reload.
- **Bootnode connection issues.** Patterns at `smoldot.ts:98-106` (`reset by remote`, `refused`, `closed`, `timeout`, `no longer reachable`, `handshake`, `all bootnodes`) trigger `onConnectionIssue` listeners. The UI surfaces these to the user.
- **CPU long-task warnings.** Smoldot's WASM warns when a single Rust `poll()` blocks the thread for at least 150ms (smoldot upstream `wasm-node/rust/src/platform.rs:167`). Format: `` The task named `add-chain-N` has occupied the CPU for an unreasonable amount of time (Xms). `` The `N` suffix comes from the spawned task name. How the counter is scoped (per-client vs. process-global) has not been verified, so do not infer correlations from `N` alone.
- **Cached chain promises.** Each `get*Chain()` factory caches its promise. On rejection the promise is nulled out so the next call retries. On `terminateSmoldot()` (`smoldot.ts:194`) every cached chain promise is cleared so a freshly-restarted smoldot doesn't hand back dead-chain handles.

## Owner-only APIs

These resolver-package exports are owner-only and must not be imported outside
`apps/protocol/`:

- `chains.ts`: `createSmoldotUpstreamProvider`, `isChainSupported`
- `resolve.ts` re-exports of `getSmoldot`, `getSmoldotDirect`, `getRelayChain`, `onConnectionIssue` plus the chain-touching helpers `resolveDotName`, `resolveOwner`, `waitForAssetHubFinalized`, `destroyResolverClient`, and `setResolverAssetHubProvider` (the bootstrap seam that points the resolver's Asset Hub reads at the broker's local session)
- `smoldot.ts`: `getSmoldot`, `getSmoldotDirect`, `terminateSmoldot`, `onSmoldotFatal`, `onConnectionIssue`, `getRelayChain`, `getBulletinChain`, `getPeopleChain`, `getDappAssetHubChain`, `getDappAssetHubProvider`, `makeNonRemovingChain`

## Adding a new chain

Steps to make a parachain reachable through the protocol iframe. The sequence below is inferred from the existing layout (relay, Asset Hub, Bulletin), and has not been exercised end-to-end in this branch.

1. Drop the chain spec JSON into `packages/resolver/src/chain-specs/`.
2. Add a loader in `packages/resolver/src/chain-specs/index.ts`. Mirror `getBulletinPaseoChainSpec`.
3. Add a `get<Name>Chain()` factory in `packages/resolver/src/smoldot.ts`. Mirror `getBulletinChain`. Set `potentialRelayChains` correctly.
4. Add the chain's genesis hash as a `0x…` constant in `packages/config/src/config.ts`. Include it in `SUPPORTED_GENESIS_HASHES`.
5. Wire the factory into `createSmoldotUpstreamProvider` in `packages/resolver/src/chains.ts` so the protocol runtime routes the genesis hash to the new chain.
6. Raw string-wire consumers call `connectChain(<your-genesis>)`. PAPI consumers use `createRemoteChainProvider(<your-genesis>)`. Rust Core uses `connectChain()` through the host callback.

Steps 4 and 5 make a chain reachable through the protocol broker. The request
fails with `UNSUPPORTED_CHAIN` when the active backend cannot serve it.

## Related

- [Resolution design](resolution-design.md). Cold-start latency distribution and the shared Asset Hub follow via the broker.
