# dotli host layer migration to TrUAPI

This document records the current dotli host cutover state. The old
`@novasamatech/*` host-container path is no longer part of the runtime design:
dotli launches products through the Rust-backed TrUAPI host bridge and keeps
only its own `.dot` resolution/smoldot protocol outside that boundary.

## Current integration

dotli still has two protocol layers:

1. Host-product API frames, handled by TrUAPI.
2. dotli's internal host-smoldot protocol in `packages/protocol/`, which owns
   `.dot` resolution and is not replaced by TrUAPI.

The active launch path is `packages/ui/src/bridge.ts`:

- imports `@parity/truapi-host/web` and
  `@parity/truapi-host/worker-runtime?worker`;
- starts a Web Worker that owns the `truapi-server` WASM core;
- creates the worker runtime with `createWebWorkerPairingHostRuntime(...)`;
- supplies typed callbacks from `packages/ui/src/host-callbacks/handlers.ts`;
- creates a product-scoped provider with `runtime.createProvider({ productId })`;
- calls `createIframeHost(...)` with the product URL, sandbox policy, allowed
  origin, and the worker-backed provider.

Product frames enter the Rust core through the iframe `MessageChannel`.
Account, signing, statement-store, SSO pairing, restore, and logout are
core-owned and do not cross the JS host callback boundary as Nova-specific
routes.

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

These callbacks must remain generic host primitives. They should not re-add
Nova package imports, wallet-specific JS channels, or statement-store request
routing that belongs inside the Rust core.

## Dependencies

`packages/ui/package.json` depends on the published TrUAPI packages:

```jsonc
"@parity/truapi": "0.5.0",
"@parity/truapi-host": "0.2.0"
```

Standalone dotli installs and CI exercise these npm artifacts. TrUAPI's
development and E2E Make targets run `bun run link:truapi` after building the
local packages, so parent-repo work always exercises the current checkout
instead of the npm artifacts.

The runtime manifests and source must not depend on or import the removed
`@novasamatech/*` runtime packages.

## Nested dApps

The old `setupNestedBridgeDetector` path created extra JS bridges for nested
iframe sources. TrUAPI v1 does not create separate nested Rust runtimes,
sessions, product identities, or storage namespaces. If nested traffic is
forwarded later, it must use the shared top-level Rust core/provider context.

The future usefulness of independent nested-product semantics is tracked in the
parent TrUAPI design note `docs/design/host-contract-and-core-impl/I -
nested-dapps.md`.

## Non-TrUAPI dotli layers

These areas remain dotli-owned and are intentionally outside the host-product
replacement:

- `apps/host/src/main.ts`: landing shell, `.dot` resolution, iframe mounting.
- `apps/sandbox/src/main.ts`: content renderer.
- `packages/protocol/`: smoldot protocol client/broker/session plumbing.
- `packages/resolver/`: `.dot` name resolution.
- `packages/content/` and `packages/storage/`: archive fetch and cache.
- `packages/config/`, `packages/metrics/`, and `packages/shared/`: support
  libraries.

When auditing the migration, treat Nova runtime imports/dependencies as a
regression, but do not confuse dotli's internal `packages/protocol/` with the
removed host-product protocol.
