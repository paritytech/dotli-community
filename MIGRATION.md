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
