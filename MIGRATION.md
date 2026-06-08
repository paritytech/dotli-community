# dotli host layer migration to TrUAPI

> Current status: this file started as the pre-migration inventory. The dotli
> host now boots a WASM TrUAPI runtime through
> `packages/ui/src/bridge.ts`, wires concrete callbacks from
> `packages/ui/src/host-callbacks/`, and uses `@parity/truapi-host-wasm` for
> iframe transport and the Rust worker runtime. Keep the inventory below as
> historical context, but use this status section for onboarding.

## Current TrUAPI integration

dotli still has two separate protocol layers:

1. Host-product API frames, now handled by TrUAPI.
2. dotli's internal host-smoldot protocol in `packages/protocol/`, which still
   owns `.dot` resolution and remains outside TrUAPI.

The active launch path is `packages/ui/src/bridge.ts`:

- dynamically imports `@parity/truapi-host-wasm/web` and the worker entrypoint
  `@parity/truapi-host-wasm/worker-runtime?worker`
- spawns a Web Worker that owns the truapi-server wasm core (smoldot's
  CPU runs off the page main thread)
- adapts typed dotli host callbacks with `createWasmRawCallbacks(...)`
- calls `createWebWorkerProvider(new HostWorker(), rawCallbacks, { runtimeConfig })`
- supplies dotli callbacks from `packages/ui/src/host-callbacks/handlers.ts`
- calls `createIframeHost(...)` with the product URL, sandbox policy, and
  allowed origin, then pipes the iframe `MessagePort` provider to the worker
  provider

`createIframeHost` keeps `MessageChannel` as the canonical transport for
products built with `@parity/truapi`. Product byte frames enter the same Rust
runtime through the worker provider.

Account, signing, and statement-store behavior are core-owned and no longer
cross the JS host callback boundary. Dotli still supplies platform primitives
under `packages/ui/src/host-callbacks/`: navigation, notification/cancel,
device and remote permission prompts, feature support, local storage, chain
connect, preimage lookup, and theme subscription.

Known limitation: nested dApp-in-dApp bridging from the old
`setupNestedBridgeDetector` path is still dropped. `createIframeHost` uses one
dedicated iframe transport and does not yet expose an `attachNested` API.

## Historical inventory

This document is the Phase 2 inventory for the host rewrite described in the
parent repo's plan (commit `d06c09b` on branch `pg/dotli-submodule`). It
categorizes every dotli module touched by the host-API boundary so Phase 3 can
delete, keep, or rewrite with confidence.

Terminology note — dotli has **two** "protocol" layers that a casual reader
will conflate:

1. **Host ↔ product protocol**, today provided by `@novasamatech/host-api` +
   `@novasamatech/host-container` (external npm). This is what TrUAPI replaces.
2. **Host ↔ smoldot protocol**, dotli-internal, lives in `packages/protocol/`
   and `apps/protocol/`. This is NOT replaced; it isolates smoldot on its own
   origin and provides `.dot` name resolution. Keep it.

The rewrite only touches layer (1). Layer (2) is load-bearing for `.dot`
resolution in `apps/host` and stays as-is.

## Architecture today

```
dot.li (apps/host)                    → landing shell, resolves label.dot → CID
  │
  ├── @dotli/protocol/client ────────→ protocol.dot.li iframe (smoldot, auth)
  │                                     (LAYER 2 — keep)
  │
  └── renderAppSubdomain(cid, label)
        │
        ▼
      cid.app.dot.li iframe  ←─────── @novasamatech/host-container bridge
      (apps/sandbox)                   (LAYER 1 — REPLACE with TrUAPI)
        │                                setupContainer + wireContainerHandlers
        │                                setupNestedBridgeDetector
        └── document.write(html)         (packages/ui/src/container.ts)
```

Layer 1 wiring lives entirely in `packages/ui/src/{bridge,container}.ts`. The
sandbox app (`apps/sandbox/src/main.ts`) is a content renderer, not a host —
it does not touch the container API. `apps/host/src/main.ts` calls
`renderIframe` / `renderAppSubdomain` in `@dotli/ui/bridge`, which is where
`setupContainer` is invoked.

## Replacement mapping

`wireContainerHandlers` (the 600-line function in
`packages/ui/src/container.ts`) maps 1:1 onto a `WasmHostCallbacks` record
under `@truapi/host-shared`:

| novasamatech handler                     | TrUAPI callback                | Behavior migrates to                                                                                                             |
| ---------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `handleFeatureSupported`                 | `featureSupported`             | same: `isRemoteChainSupported` from `@dotli/protocol/client`                                                                     |
| `handleChainConnection`                  | —                              | **dropped**: TrUAPI does not expose raw chain providers; layer-2 handles it via its own iframe                                   |
| `handleAccountGet`                       | —                              | **out of scope** for this PR (no TrUAPI callback yet); keep behind a temp adapter or stub until contract lands                   |
| `handleGetNonProductAccounts`            | —                              | same as above                                                                                                                    |
| `handleAccountConnectionStatusSubscribe` | —                              | same as above                                                                                                                    |
| `handleAccountGetAlias`                  | —                              | same as above                                                                                                                    |
| `handleSignPayload` / `handleSignRaw`    | —                              | same as above                                                                                                                    |
| `handleStatementStore*`                  | —                              | same as above                                                                                                                    |
| `handlePreimage*`                        | —                              | same as above                                                                                                                    |
| `handleNavigateTo`                       | `navigateTo`                   | `dotNsUrl` parser + existing `window.open` logic                                                                                 |
| `handleDevicePermission`                 | `devicePermission`             | `getPermissionStatus` / `setPermissionStatus` from `packages/ui/src/permissions.ts`, + `showPermissionRequestModal`              |
| `handlePermission` (TransactionSubmit)   | `remotePermission`             | same permissions store; split into `ChainSubmit` + `StatementSubmit` (see `demos/hosts/web/src/callbacks/RemotePermission.ts:9`) |
| `handlePushNotification`                 | `pushNotification`             | `showPushNotification` from `packages/ui/src/notification.ts`                                                                    |
| `handleLocalStorageRead/Write/Clear`     | `localStorageRead/Write/Clear` | `localStorage` with `storagePrefix = "dotli:${label}:"`                                                                          |

**Account / signing / statement-store / preimage are not covered by the
TrUAPI callback contract today.** The rewrite cannot delete that code without
breaking dotli. For this PR we:

1. Replace only the callbacks present in `WasmHostCallbacks` (7 entries).
2. Keep dotli's account/signing/statement/preimage flows reachable via a
   temporary adapter that continues to wire them onto the TrUAPI host's
   product-side message boundary (or feature-gate them off, pending the
   broader TrUAPI contract expansion). This adapter is the only piece of
   `@novasamatech/host-container` that survives Phase 3. Flag in PR for
   follow-up.

## Delete (layer 1)

| Path                                  | Reason                                                                                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ui/src/container.ts`        | `wireContainerHandlers` + `setupContainer` + `setupNestedBridgeDetector` + `createWindowProvider`: replaced by `createIframeHost` + `createHostCallbacks`                           |
| `packages/ui/src/bridge.ts` (parts)   | Keep `renderArchive` / `renderContent` / `prepareIframe` re-exports from `render.ts`; rewrite `renderIframe` + `renderAppSubdomain` to call `createIframeHost` with the new runtime |
| `@novasamatech/host-api` usage        | Error classes (`SigningErr`, `StorageErr`, etc.) become unused once account/signing wiring migrates; drop the dep once the adapter above is retired                                 |
| `@novasamatech/host-container` usage  | `createContainer` / `createIframeProvider` replaced by TrUAPI runtime + iframe host                                                                                                 |
| `@novasamatech/sdk-statement` mapping | `statement-store-mapping.ts` — unused once statement-store callbacks migrate; drop with follow-up                                                                                   |

Every consumer of the deleted modules has to move to the new entry. The only
expected external import sites are:

- `packages/ui/src/bridge.ts` (obvious)
- `apps/host/src/main.ts` (via `@dotli/ui/bridge` only, should be untouched)

## Keep (UI primitives called by callbacks)

| Path                                        | Role in Phase 3                                                                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ui/src/permissions.ts`            | `getPermissionStatus`, `setPermissionStatus`, `buildAllowAttribute` — called from `devicePermission` + `remotePermission` callbacks |
| `packages/ui/src/permission-modal.ts`       | `showPermissionRequestModal` — consent UI, called from permission callbacks                                                         |
| `packages/ui/src/notification.ts`           | `showNotification`, `showPushNotification` — called from push + permission denial callbacks                                         |
| `packages/ui/src/alias-permission-modal.ts` | Account-alias consent modal — still used by the temporary adapter (see "Replacement mapping" above)                                 |
| `packages/ui/src/preimage-modal.ts`         | Used by temporary adapter                                                                                                           |
| `packages/ui/src/password-prompt.ts`        | Used by `apps/sandbox`, orthogonal                                                                                                  |
| `packages/ui/src/topbar.ts`                 | UI shell, independent of host boundary                                                                                              |
| `packages/ui/src/ui.ts`                     | UI shell                                                                                                                            |
| `packages/ui/src/render.ts`                 | Iframe element creation, DOM plumbing (still used by `bridge.ts` for non-container paths)                                           |
| `packages/shared/src/dotns-url.ts`          | Parser used by `navigateTo` callback                                                                                                |
| `packages/auth/*`                           | Session, signing UI — used by temporary adapter                                                                                     |

## Keep (host shell, unchanged)

| Path                              | Reason                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `apps/host/src/main.ts`           | Landing + resolution + shell. Calls `@dotli/ui/bridge` which we rewrite; no direct host-API coupling |
| `apps/sandbox/src/main.ts`        | Content fetch + render; not a host                                                                   |
| `apps/protocol/*`                 | Layer-2 smoldot iframe; not touched                                                                  |
| `packages/protocol/*`             | Layer-2 client + messages + broker + auth-storage; not touched                                       |
| `packages/resolver/*`             | `.dot` name resolution; orthogonal                                                                   |
| `packages/content/*`              | Helia/IPFS archive fetch; orthogonal                                                                 |
| `packages/storage/*`              | CID cache; orthogonal                                                                                |
| `packages/config/*`               | Env + mode config; orthogonal                                                                        |
| `packages/metrics/*`              | Observability; orthogonal                                                                            |
| `packages/sandbox-checker/*`      | Sandbox lint overlay; orthogonal                                                                     |
| `packages/shared/*` (minus dotns) | Shared helpers; orthogonal                                                                           |

## Rewrite (product launch entry)

`packages/ui/src/bridge.ts` is the seam. Both `renderIframe(url, label)` and
`renderAppSubdomain(cid, label)` currently call `setupContainer` +
`setupNestedBridgeDetector` from `./container.ts`. Replace that pair with:

```ts
import { createWebWasmRequestHostRuntime } from "@truapi/host-shared/dist/web-runtime.js";
import { createIframeHost } from "@truapi/host-web";
import { createHostCallbacks } from "./handlers.js";

const runtime = await createWebWasmRequestHostRuntime(
  createHostCallbacks({ log, label, storageScopeId: iframe.src }),
);

const host = createIframeHost({
  iframeUrl: url,
  allowedOrigin: new URL(url).origin,
  container: app,
  runtime,
});
```

The `handlers.ts` / `callbacks/*.ts` files mirror the demo
(`demos/hosts/web/src/handlers.ts` and `src/callbacks/*.ts`) one-for-one;
each callback body swaps the demo's fixture/notifier call for the dotli
primitive per the "Replacement mapping" table above.

The nested-bridge feature in `setupNestedBridgeDetector` (dApp-in-dApp) is
not supported by `createIframeHost` yet. Dotli has a `MAX_NESTED_BRIDGES`
config and multiple active users of nested bridges are unlikely, but **call
this out in the PR**: Phase 3 drops nested-bridge support until TrUAPI adds
an equivalent API. Track as a follow-up.

## Dependency changes for Phase 3

Add to dotli UI package dependencies:

```jsonc
"dependencies": {
  "@parity/truapi": "file:../../../../js/packages/truapi",
  "@parity/truapi-host-wasm": "file:../../../../js/packages/truapi-host-wasm"
}
```

Path is relative to `packages/ui/`, which resolves up into the parent TrUAPI
repo. `bun install` will symlink the local packages.

Drop (once account/signing adapter retires):

```jsonc
"@novasamatech/host-api": "...",
"@novasamatech/host-container": "...",
"@novasamatech/sdk-statement": "...",
"@novasamatech/statement-store": "...",
"@novasamatech/host-papp": "..."
```

Phase 3 keeps them for the temporary adapter. A follow-up PR drops them
along with `statement-store-mapping.ts`, `auth/signing.ts`, etc.

## Phase 3 file plan

New:

- `web/host/packages/ui/src/host-callbacks/handlers.ts`
- `web/host/packages/ui/src/host-callbacks/FeatureSupported.ts`
- `web/host/packages/ui/src/host-callbacks/NavigateTo.ts`
- `web/host/packages/ui/src/host-callbacks/PushNotification.ts`
- `web/host/packages/ui/src/host-callbacks/DevicePermission.ts`
- `web/host/packages/ui/src/host-callbacks/RemotePermission.ts`
- `web/host/packages/ui/src/host-callbacks/LocalStorage.ts`

Modified:

- `web/host/packages/ui/src/bridge.ts` — swap `setupContainer` for `createIframeHost` + host runtime
- `web/host/packages/ui/package.json` — add `@parity/*` local deps

Deleted:

- `web/host/packages/ui/src/container.ts` (entire file)

Retained + rewired (temporary adapter for account/signing/statement/preimage):

- TODO in Phase 3: design a minimal shim that keeps those handlers reachable
  over the TrUAPI iframe boundary, or accept that dotli temporarily loses
  those features on `pg/truapi` until TrUAPI expands its callback set.
  Recommend feature-flagging behind `import.meta.env.VITE_TRUAPI = "1"` for
  the first iteration so the `main` branch is unaffected.
