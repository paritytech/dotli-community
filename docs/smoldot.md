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

In default config, exactly one smoldot client runs per session, owned by the protocol iframe.

| Origin | Purpose | Triggered by |
|---|---|---|
| Protocol iframe (`host.localhost`, production `paseo.li`) | Domain resolution (Asset Hub query to CID), bitswap content fetching, Bulletin Paseo preimage submission | `apps/protocol/src/main.ts` (direct/shared-worker submodes) and `apps/protocol/src/protocol-shared-worker.ts` |
| Host shell (user's destination domain, e.g. `foo.dot`) | None today, except an opt-in path: People chain auth when `VITE_SS_USE_SMOLDOT=true` | `packages/auth/src/auth.ts:210` (`getPeopleChainProvider()`, opt-in only) |

The protocol-iframe smoldot is constructed via the singletons in `packages/resolver/src/smoldot.ts`. The opt-in People-chain path on the host shell still spins up a second smoldot at the user's origin, gated by the `VITE_SS_USE_SMOLDOT` env flag.

## Smoldot factories

Two factories live in `packages/resolver/src/smoldot.ts`:

- `getSmoldot()` (line 171) calls `startFromWorker(new SmWorker(), …)`. Smoldot runs in a dedicated Web Worker. Used in iframe main-thread contexts.
- `getSmoldotDirect()` (line 158) calls `start(…)`. Smoldot runs on the calling thread. Used inside the SharedWorker, where the `Worker` constructor is unavailable.

Both share the same `smoldotInstance` cell (line 148). Calling either returns the existing client if one is already constructed.

## Chains

Five chain factories ship in `packages/resolver/src/smoldot.ts`.

| Function | Chain | Purpose | Genesis hash |
|---|---|---|---|
| `getRelayChain()` | Paseo relay | Required parent for the parachains below | `PASEO_RELAY_GENESIS` (`config.ts:83`) |
| `getDappAssetHubChain()` | Asset Hub Paseo | Domain resolution and product queries (single shared chain) | `ASSET_HUB_PASEO_GENESIS` (`config.ts:85`) |
| `getBulletinChain()` | Bulletin Paseo | Preimage submission via `TransactionStorage.store` | `BULLETIN_PASEO_GENESIS` (`config.ts:87`) |
| `getPeopleChain()` | People (chain spec selected by `SS_PEOPLE_CHAIN`, currently `next-people-paseo`) | Statement-store auth | not in `SUPPORTED_GENESIS_HASHES` |

There is exactly one Asset Hub chain (`getDappAssetHubChain()`, `smoldot.ts:519`), shared by the resolver and every dApp session through the `ChainBroker`. The broker opens a single follow that is never removed mid-read. The resolver reads through a local broker session (`broker.getLocalProvider(genesis)`, object-wire), and dApp connections attach as remote sessions on the same follow. This replaced the earlier resolver/product chain split. In that split the resolver's chain was released once the CID was cached, so the first dApp connection releasing that follow mid-read produced the `ChainHead disjointed` load failure.

`SUPPORTED_GENESIS_HASHES` (`config.ts:90`) contains relay, Asset Hub, and Bulletin. People chain is not in the set today, which is why the host shell still spins up its own smoldot for it under `VITE_SS_USE_SMOLDOT=true`.

## Protocol modes

The protocol iframe parses a `?mode=` URL parameter (`apps/protocol/src/main.ts:318`) and dispatches at `main.ts:443-466`.

- `?mode=shared-worker` opens a `SharedWorker` (`apps/protocol/src/protocol-shared-worker.ts`). Smoldot runs in the worker thread.
- `?mode=direct` runs `initDirectMode()` (`main.ts:593`), which dynamic-imports the resolver and runs smoldot on the iframe main thread.
- `?mode=rpc` runs `initRpcMode()` (`main.ts:658`). No smoldot. Chain calls go to a trusted WSS JSON-RPC endpoint.

The host shell selects the submode from `chainBackend` at `apps/host/src/main.ts:366-371`.

## Talking to a chain

Code in `packages/ui`, `packages/auth`, and `apps/host` must not import `@dotli/resolver/{smoldot,bulletin,chains,resolve}`. Use the cross-origin seam exposed by `@dotli/protocol/client`:

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

For Bulletin Paseo preimage submission, use `submitPreimageRemote(value)` (`client.ts:543`). The protocol iframe runs the full submit flow (build extrinsic, sign with the test signer, watch until included) against its bulletin chain. Consumers never hold key material.

## Persistence

Smoldot persists chain DBs to IndexedDB internally. dotli does not manage save/load. The comment at `smoldot.ts:8-9` is explicit on this.

Pre-cutover host-side smoldot may have left an IndexedDB chain DB at the user's destination origin. Stale state from the deleted code path stays on disk until the user clears storage. There is no `dotli doctor` command for this today.

## Failure modes

- **Smoldot panic.** The log callback (`smoldot.ts:122-127`) detects `"Smoldot has panicked"` and `"panicked at"` and broadcasts a fatal signal via `onSmoldotFatal`. The protocol iframe forwards `fatal` envelopes to the host client, which rejects every pending request. Recovery requires a reload.
- **Bootnode connection issues.** Patterns at `smoldot.ts:98-106` (`reset by remote`, `refused`, `closed`, `timeout`, `no longer reachable`, `handshake`, `all bootnodes`) trigger `onConnectionIssue` listeners. The UI surfaces these to the user.
- **CPU long-task warnings.** Smoldot's WASM warns when a single Rust `poll()` blocks the thread for at least 150ms (smoldot upstream `wasm-node/rust/src/platform.rs:167`). Format: `` The task named `add-chain-N` has occupied the CPU for an unreasonable amount of time (Xms). `` The `N` suffix comes from the spawned task name. How the counter is scoped (per-client vs. process-global) has not been verified, so do not infer correlations from `N` alone.
- **Cached chain promises.** Each `get*Chain()` factory caches its promise. On rejection the promise is nulled out so the next call retries. On `terminateSmoldot()` (`smoldot.ts:194`) every cached chain promise is cleared so a freshly-restarted smoldot doesn't hand back dead-chain handles.

## Owner-only APIs

These resolver-package exports are owner-only and must not be imported outside `apps/protocol/`:

- `smoldot.ts`: `getSmoldot`, `getSmoldotDirect`, `terminateSmoldot`, `onSmoldotFatal`, `onConnectionIssue`, `getRelayChain`, `getBulletinChain`, `getPeopleChain`, `getDappAssetHubChain`, `getDappAssetHubProvider`, `makeNonRemovingChain`, `getPeopleChainProvider`
- `bulletin.ts`: `ensureBulletinClient`, `submitPreimageTransaction`, `getTestSigner`
- `chains.ts`: `createChainProvider`, `isChainSupported`
- `resolve.ts` re-exports of `getSmoldot`, `getSmoldotDirect`, `getRelayChain`, `onConnectionIssue` plus the chain-touching helpers `resolveDotName`, `resolveOwner`, `waitForAssetHubFinalized`, `destroyResolverClient`, and `setResolverAssetHubProvider` (the bootstrap seam that points the resolver's Asset Hub reads at the broker's local session)

Enforced by `packages/ui/tests/owner-boundary.contract.test.ts`, which currently bans `@dotli/resolver/bulletin` imports in `packages/ui/src/`, `packages/auth/src/`, and `apps/host/src/`. The remaining reach-in is `packages/auth/src/auth.ts:24` (`getPeopleChainProvider`), gated by `VITE_SS_USE_SMOLDOT` and out of scope for this change.

## Adding a new chain

Steps to make a parachain reachable through the protocol iframe. The sequence below is inferred from the existing layout (relay, Asset Hub, Bulletin), and has not been exercised end-to-end in this branch.

1. Drop the chain spec JSON into `packages/resolver/src/chain-specs/`.
2. Add a loader in `packages/resolver/src/chain-specs/index.ts`. Mirror `getBulletinPaseoChainSpec`.
3. Add a `get<Name>Chain()` factory in `packages/resolver/src/smoldot.ts`. Mirror `getBulletinChain`. Set `potentialRelayChains` correctly.
4. Add the chain's genesis hash as a `0x…` constant in `packages/config/src/config.ts`. Include it in `SUPPORTED_GENESIS_HASHES`.
5. Wire the factory into `createChainProvider` in `packages/resolver/src/chains.ts` so the protocol iframe routes the genesis hash to the new chain.
6. Consumer code calls `createRemoteChainProvider(<your-genesis>)` from `@dotli/protocol/client`. No host-side smoldot required.

Steps 4 and 5 are what makes a chain reachable from the host shell across the postMessage seam. Skip them and the host either crashes with `"Unsupported chain"` or silently spins up its own smoldot. This is the current People chain situation.

## Related

- [Resolution design](resolution-design.md). Cold-start latency distribution and the shared Asset Hub follow via the broker.
