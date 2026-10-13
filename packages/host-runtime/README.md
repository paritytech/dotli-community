# `@dotli/host-runtime`

The host side of TrUAPI and the session, without any UI. It boots the page's TrUAPI core, pipes the product frame to it,
and owns the login, wallet and permission state the host app reads.

## Responsibility

- The bridge: one page core, the product frame piped to it, and the host callbacks (chain, chat, storage, prompts,
  notifications).
- Login and logout through the pairing host (Polkadot App) or a local wallet, and the wallet mode and switch.
- The stores the runtime writes, which import no Solid: auth, product, product permissions, theme, wallet mode, chat.
- Not the views. Prompts, modals, notifications and the frame view come from the app through ports. Product content and
  chain data come from the data packages.

## Design

- The bridge is wired from a set of injected dependencies. The real wiring is its own lazy chunk, so the boot path never
  loads the TrUAPI host.
- One runtime boots per page core. It uses a signing host on the local wallet when one is found, else the pairing host.
  The page core owns the core's lifetime and its connection.
- Each TrUAPI callback has one handler, built from `HostCallbackPorts`. Handlers ask the app through ports and never
  import a view.
- The host chain pool reports who holds each chain and its best blocks to the `chainActivity` port in `BridgePorts`. The
  watch attaches once, on the first `initBridge`. It replays the chains already held and never holds one itself.
- A prompt port and a queue show one blocking modal at a time. The auth controller drives the sign-in modal through
  `AuthModalPort`.
- The product frame host creates the product iframe and reports its status up. Shared mode follows the session that
  other subdomains share through the protocol frame, and `getSharedChannel` hands the app that same store for its own
  shared state.
- State lives in sync stores that import no Solid. State flows up to the app, intent flows down through ports and
  commands.
- The product the app renders carries what the runtime needs to know of it: whether it declares chat, as a promise the
  frame awaits before it connects the product, and the name and versions its manifests publish. The frame names the tab
  from them and records them in the product store for the chat panel and the diagnostics.
- The signing worker and the local wallet core load on demand through lazy loaders.
- Failures are reported with `captureException`, a log line and an outcome metric. A core that goes stale is rebuilt
  without being asked.
- No Solid and no UI. Lint enforces it.

## Public API

### `@dotli/host-runtime`

- Bridge: `loadBridge`, `loadSharedMode` (lazy loaders), `BridgePorts`, `HostCallbackPorts`, `BridgeModule`.
- Prompts and modals: `HostPrompts` with its dialog and notice types, `createBlockingModalCoordinator`,
  `BlockingModalCoordinator`.
- Product frame: `ProductFrame`, `ProductFrameView`, `ProductFrameStatus`, `FrameProduct`, `TitledProduct`.
- Auth: `initAuthController`, `startLogin`, `retryLogin`, `logout`, `closeAuthModal`, `disableAuthModal`,
  `AuthModalPort`, `AuthModalView`, `AuthModalState`, `AuthCommands`.
- Wallet: `walletSwitch`, `walletModeStore`, `phraseToEntropy`, `schedulePendingReset`, `takePendingReset`.
- Session and permissions: `startSessionState`, `TruapiSessionUiState`, `DotliAuthState`, `ALL_PERMISSIONS`,
  `isDevicePermission`, `startProductPermissions`, `chooseProductPermission`, `refreshProductPermissions`,
  `resetProductPermissions`, `onPermissionsChanged`, `productPermissionsStore`.
- Stores: `authStore`, `loggedInStore`, `getLoggedIn`, `setAuthState`, `productStore`, `getProductState`,
  `setProductLoaded`, `setProductError`, `ProductDetails`, `ManifestFacts`, `AppVersion`, `themeStore`, `getThemeState`,
  `setTheme`.
- Chat: `chatStore`, `createChatStore`, `createChatConnections`, `ChatRepo`, `ChatStore`, `ChatView` and the record
  types.
- Notifications: `createPageScheduledNotifications`, `ScheduledNotifications`, `NotificationScheduler`.
- Shared store: `getSharedChannel`, `SharedChannel`.
- Misc: `pageDiagnostics`, `dotliVersion`, `labelToProductId`.

### `@dotli/host-runtime/testing`

Fakes that other packages' tests drive the runtime with. Never imported by shipped code.

- `createFakePageCore`, `answerConnection`, `FakePageCore`: a page core without a worker.
- `createProductFrame`: the real frame host, for tests that pass their own deps.
- `memoryChatRepo`, `recordingConnection`: chat repo and connection fakes.
- `memorySharedChannel`, `MemorySharedChannel`: the shared-mode channel.
- `resetAuthControllerForTests`.
