# dotli host layer migration to TrUAPI

This document records the current dotli host cutover state. The old `@novasamatech/*` host-container path is no longer
part of the runtime design: dotli launches products through the Rust-backed TrUAPI host bridge and keeps only its own
`.dot` resolution/smoldot protocol outside that boundary.

## Current integration

dotli still has two protocol layers:

1. Host-product API frames, handled by TrUAPI.
2. dotli's internal host-smoldot protocol in `packages/protocol/`, which owns `.dot` resolution and is not replaced by
   TrUAPI.

The active launch path is `apps/host/src/runtime/bridge.ts`:

- imports `@parity/truapi-host/web` and `@parity/truapi-host/worker-runtime?worker`;
- starts a Web Worker that owns the `truapi-server` WASM core;
- creates the worker runtime with `createWebWorkerPairingHostRuntime(...)`;
- supplies typed callbacks from `apps/host/src/runtime/host-callbacks/handlers.ts`;
- creates a product-scoped provider with `runtime.createProvider({ productId })`;
- calls `createIframeHost(...)` with the product URL, sandbox policy, allowed origin, and the worker-backed provider.

Product frames enter the Rust core through the iframe `MessageChannel`. Account, signing, statement-store, SSO pairing,
restore, and logout are core-owned and do not cross the JS host callback boundary as Nova-specific routes.

## dotli callback boundary

dotli still supplies platform primitives that are host policy or browser UI:

| Area                      | Files                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| navigation                | `apps/host/src/runtime/host-callbacks/open-url.ts`                                                  |
| notifications             | `apps/host/src/runtime/host-callbacks/push-notification.ts`                                         |
| device/remote permissions | `apps/host/src/runtime/host-callbacks/prompt-permission.ts`, `apps/host/src/runtime/permissions.ts` |
| feature support           | `apps/host/src/runtime/host-callbacks/feature-supported.ts`                                         |
| product storage           | `apps/host/src/runtime/host-callbacks/local-storage.ts`                                             |
| session persistence       | `apps/host/src/runtime/session/core-storage.ts`, `session-state.ts`                                 |
| pairing presentation      | `apps/host/src/runtime/session/auth-state.ts`                                                       |
| user confirmations        | `apps/host/src/runtime/host-callbacks/user-confirmation.ts`                                         |
| preimage lookup UI        | `apps/host/src/runtime/host-callbacks/preimage.ts`                                                  |
| theme subscription        | `apps/host/src/runtime/host-callbacks/theme.ts`                                                     |
| chain backend connection  | `apps/host/src/runtime/host-callbacks/chain.ts`                                                     |

These callbacks must remain generic host primitives. They should not re-add Nova package imports, wallet-specific JS
channels, or statement-store request routing that belongs inside the Rust core.

## Dependencies

`apps/host/package.json` depends on the published TrUAPI packages:

```jsonc
"@parity/truapi": "0.24.0",
"@parity/truapi-host": "0.24.0"
```

Standalone dotli installs and CI exercise these npm artifacts. TrUAPI's development and E2E Make targets run
`npm run link:truapi` after building the local packages, so parent-repo work always exercises the current checkout
instead of the npm artifacts.

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
- `packages/bitswap/`, `packages/content/` and `packages/storage/`: block fetch and relay, archive fetch and cache.
- `packages/config/`, `packages/metrics/`, and `packages/shared/`: support libraries.

When auditing the migration, treat Nova runtime imports/dependencies as a regression, but do not confuse dotli's
internal `packages/protocol/` with the removed host-product protocol.
