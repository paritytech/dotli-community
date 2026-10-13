# `@dotli/protocol`

The host page's client for the hidden protocol frame, the origin that runs the light client and the shared store. It
turns postMessage traffic into promises, streams and remote chain connections.

## Responsibility

- The protocol iframe lifecycle: boot on demand, status, rebuild when lost.
- Typed requests to the frame: resolving a `.dot` name and its manifests, remote chain connections, the shared store of
  auth, mode and local wallet.
- Telemetry the frame reports: chain sync, peers, traffic and the light client's saved database.
- Not the frame's own code, name resolution logic, the chain pool, the light client or the halt marker.

## Design

```mermaid
flowchart LR
  client --> facades["facades: resolve, chain, shared store, telemetry"]
  facades --> rpc --> frame --> origin[protocol origin]
```

- The frame module creates the iframe, publishes a `ProtocolStatus` (`idle`, `booting`, `listening`, `ready`, `failed`)
  and is the only listener for its messages. It rebuilds itself when lost. Boot is deduped with a task pool.
- The wire contract holds the envelope guards. Events pass an origin and source check, then a payload check.
- The rpc layer sends requests and matches answers, with a timeout per method.
- The client builds the page's one instance from `createProtocolClient`. Its facades cover resolution, remote chains,
  the shared store and telemetry.
- A remote chain connection answers a request its chain halted under with the chain pool's halt marker, and tells its
  consumer whether the chain or the whole frame stopped.
- Shared store keys are named in one place, and only allowed origins may use them.
- The frame's failures are reported with `captureException` and outcome metrics. Calls from several callers share one
  frame.

## Public API

### `@dotli/protocol`

- Client: `createProtocolClient`, `ProtocolClient`, `ProtocolClientDeps`, `configureProtocolFrame`,
  `ensureProtocolFrame`, `warmupProtocol`, `getProtocolOrigin`, `getProtocolStatus`, `subscribeProtocolStatus`.
- Resolution: `resolveDotNameRemote`, `resolveRootManifestRemote`, `resolveExecutableManifestRemote`.
- Remote chains: `createRemoteChainProvider`, `isRemoteChainSupported`, `isRemoteChainConnectable`,
  `RemoteChainProvider`.
- Shared store: `readSharedAuthStorage`, `writeSharedAuthStorage`, `clearSharedAuthStorage`,
  `subscribeSharedAuthStorage`, the matching `*SharedModeStorage` functions, `readSharedLocalWallet`,
  `saveSharedLocalWallet`, `updateSharedLocalWalletIdentity`, `forgetSharedLocalWallet`, `getSharedStoreStatus`,
  `subscribeSharedStoreStatus`.
- Key helpers: `buildSharedAuthStorageKey`, `isSharedAuthOriginAllowed`, `isValidSharedAuthKey`,
  `SHARED_CORE_SESSION_KEY`.
- Telemetry: `onProtocolChainSync`, `onProtocolChainDetail`, `onProtocolNetBytes`, `getSmoldotDbOutcome`.
- Wire and errors: `isProtocolEnvelope`, `ProtocolEnvelope`, `getRequestSyncTimeoutMs`, `ProtocolFatalError`,
  `ProtocolInitFailedError`.

There is no `testing` export.
