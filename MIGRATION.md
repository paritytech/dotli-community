# dotli host layer migration to TrUAPI

This document records the current dotli host cutover state. The old `@novasamatech/*` host-container path is no longer
part of the runtime design: dotli launches products through the Rust-backed TrUAPI host bridge and keeps only its own
`.dot` resolution/smoldot protocol outside that boundary.

## Current integration

dotli still has two protocol layers:

1. Host-product API frames, handled by TrUAPI.
2. dotli's internal host-smoldot protocol in `packages/protocol/`, which owns `.dot` resolution and is not replaced by
   TrUAPI.

The active launch path is `packages/ui/src/bridge.ts`, backed by `packages/ui/src/page-core.ts`:

- the page core owns one native worker runtime shared by shell UI and product connections;
- it boots the pairing runtime, or the local signing runtime once the debug panel's Wallet tab has switched the domain
  to a Polkadot App account used locally;
- it supplies typed callbacks from `packages/ui/src/host-callbacks/handlers.ts`: auth and session storage stay
  core-owned, while each product connection gets its own prompts, which end with that connection;
- the bridge acquires a core lease and a product-scoped connection, not a separate native runtime;
- `createIframeHost(...)` connects the product MessagePort using the exact product URL, sandbox policy, and allowed
  origin;
- replacing a product disposes its connection while other core leases remain alive;
- a faulted core is never handed out again; the next product connection boots a fresh one.

Product frames enter the page's Rust core through the iframe `MessageChannel`, using the scoped TrUAPI wire envelope.
Legacy Nova `window.postMessage` frames are rejected with a product-update notice rather than forwarded into an
incompatible decoder. Products must use a compatible TrUAPI MessagePort transport. Account, signing, statement-store,
SSO pairing, restore, and logout are core-owned and do not cross the JS host callback boundary as Nova-specific routes.

## Existing Chat and profile state

The local signing runtime keeps native Chat records, profile disclosures, received profile references and host-channel
peer keys in shared custody for the active account. Profile and peer keys include their root identity and People
network. Chat grants additionally bind the account and network because their native storage key does not include them.

On first access, an existing profile record moves from the product's storage into custody. A newer custody value wins.
Migration persists the destination before retiring the source, and a durable tombstone prevents another product's stale
copy from restoring a withdrawn record. Reads, writes and clears for one slot are serialized through the shared task pool.
An absent source does not retire that slot, so opening Chat before the profile product does not prevent migration.

Old Chat grants have no account or network binding. Their bytes are retained, but they do not grant access in the new
scope. The Chat product asks for fresh consent. Existing conversation history and profile records are not reset.

Host-channel qualification must distinguish direct delivery from the older Chat relay. Pair two accounts in Chat, then
leave Chat and share, update and withdraw a profile through Seity. Check the receiving host's
`host channel reference recorded from a contact` trace and the visible profile. Reopen the receiving host after withdrawal
to check that replay does not restore it. The native host-channel regression suite separately exercises delivery with no
Chat relay, including replay, peer and network isolation.

## dotli callback boundary

dotli still supplies platform primitives that are host policy or browser UI:

| Area                      | Files                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------- |
| navigation                | `packages/ui/src/host-callbacks/OpenUrl.ts`                                            |
| notifications             | `packages/ui/src/host-callbacks/PushNotification.ts`                                   |
| device/remote permissions | `packages/ui/src/host-callbacks/PromptPermission.ts`, `packages/ui/src/permissions.ts` |
| feature support           | `packages/ui/src/host-callbacks/FeatureSupported.ts`                                   |
| product storage           | `packages/ui/src/host-callbacks/LocalStorage.ts`                                       |
| session persistence       | `packages/ui/src/host-callbacks/SessionStore.ts`                                       |
| pairing presentation      | `packages/ui/src/host-callbacks/AuthState.ts`                                          |
| user confirmations        | `packages/ui/src/host-callbacks/UserConfirmation.ts`                                   |
| preimage lookup UI        | `packages/ui/src/host-callbacks/Preimage.ts`                                           |
| theme subscription        | `packages/ui/src/host-callbacks/Theme.ts`                                              |
| chain backend connection  | `packages/ui/src/host-callbacks/Chain.ts`                                              |

These callbacks must remain generic host primitives. They should not re-add Nova package imports, wallet-specific JS
channels, or statement-store request routing that belongs inside the Rust core.

## Dependencies

The root `package.json` uses matched vendored TrUAPI packages:

```jsonc
"@parity/truapi": "file:vendor/truapi",
"@parity/truapi-host": "file:vendor/truapi-host"
```

`vendor/truapi-host.lock.json` records the native source revision and artifact checksums. Each feature layer uses the
artifact from its corresponding native layer. `scripts/build-vendored-truapi-host.sh` regenerates the client bindings
and both WebAssembly bundles together.

Standalone installs and CI use these vendored artifacts. Local development can use `npm run link:truapi` after building
the local packages. Permission reads and changes go through core-owned administration, not page-memory overrides.

Notification activation and acknowledgement callbacks belong in the receiving integration, whose native API declares
them. The generic PolkaVM adapter does not register those receiving-only callbacks.

The runtime manifests and source must not depend on or import the removed `@novasamatech/*` runtime packages.

## Media state and permission refresh

The Media layer uses the current local signer and native Chat custody from its parent. It does not restore the retired
experimental-wallet owner or storage protocol. Wallet creation and submission behavior remain a separate feature layer
that joins the release umbrella.

Core storage compare-exchange distinguishes an absent record from an empty byte array. Encrypted custody serializes
the complete read, decrypt and write operation, including overlapping operations within one lease and lease handover.
Shared session writes, clears and compare-exchange use the same cross-document slot lock.

Media waits for queued native permission refresh before serving a product call. Storage change notifications trigger
that refresh but do not replace native permission authority. Consent callbacks return their decision without an
administrative write that could invalidate the native prompt still waiting for it.

## Nested dApps

The old `setupNestedBridgeDetector` path created extra JS bridges for nested iframe sources. TrUAPI v1 does not create
separate nested Rust runtimes, sessions, product identities, or storage namespaces. If nested traffic is forwarded
later, it must use the shared top-level Rust core/provider context.

The future usefulness of independent nested-product semantics is tracked in the parent TrUAPI design note
`docs/design/host-contract-and-core-impl/I - nested-dapps.md`.

## Non-TrUAPI dotli layers

These areas remain dotli-owned and are intentionally outside the host-product replacement:

- `apps/host/src/main.ts`: landing shell, `.dot` resolution, iframe mounting.
- `apps/sandbox/src/main.ts`: content renderer.
- `packages/protocol/`: smoldot protocol client/broker/session plumbing.
- `packages/resolver/`: `.dot` name resolution.
- `packages/content/` and `packages/storage/`: archive fetch and cache.
- `packages/config/`, `packages/metrics/`, and `packages/shared/`: support libraries.

When auditing the migration, treat Nova runtime imports/dependencies as a regression, but do not confuse dotli's
internal `packages/protocol/` with the removed host-product protocol.
