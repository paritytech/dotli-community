# `@dotli/config`

Build-time and runtime configuration for dotli: the environment, networks, chain services, the settings a user picks and
timeouts.

## Responsibility

- Owns the network table (dotNS contracts, chain services, TLD) and the active network choice.
- Owns the backend and cache settings, their storage keys and the URL form that carries them to another origin.
- Does not own the host to sandbox wire, logging, metrics or storage of product data.

## Design

- The base domain and site id come from the hostname, and `DEBUG` from the build environment. A base domain is never
  defaulted silently, since the cross-origin allowlist is keyed on it.
- The network table holds per-network service config. The active network is part of the settings, which the protocol
  frame and the sandbox set from their URL.
- Backend (`smoldot-direct`, `smoldot-shared-worker`, `rpc-gateway`) and cache switches are settings beside the network.
  One pure function resolves them from the link, the cross-subdomain store and this origin's storage. A page sets its
  settings once at boot and the getters return them. A change reloads the page, so nothing sets them after.
- A chain is named by its role (`relay`, `assethub`, `bulletin`, `people`) everywhere: the network table, sync events,
  the light client's database outcomes and the UI. A genesis hash maps to its role from the fixed config, so a worker
  that never sees the runtime network config may read it.
- Settings travel between origins as URL params. Default values are stripped, so a clean URL means every axis is at its
  default.

## Public API

### `@dotli/config`

- Environment: `BASE_DOMAIN`, `SITE_ID`, `DEBUG`, `DEV_PROTOCOL_PORT`, `DEV_SANDBOX_PORT`, `isLocalhost`,
  `isSandboxOrigin`, `BLOCK_CACHE_MAX_BYTES`, the `SCHEDULED_NOTIFICATIONS_*` limits, `TIMEOUTS`.
- Networks: `NetworkName`, `getNetwork`, `getEnabledNetworks`, `getActiveServicesConfig`,
  `getActiveFixedServicesConfig`, `getActiveTldSuffix`, `withActiveTld`, the chain role helpers (`CHAIN_ROLES`,
  `chainRoleForGenesis`, `getActiveChainRoles`) and the gateway and genesis hash readers.
- Settings: `getSettings`, `setSettings`, `getBackend`, `getCacheSettings`, `isSharedWorkerAvailable`,
  `isVerifiedSession`, `parseSettingsFromSearch`, `writeSettingsToSearch`, `resolveSettings`, `setActiveNetwork`,
  `writeLocalSettings`, `sharedSettingsOf`, `hasStoredSettings`, `Settings`, `SharedSettings`.

### `@dotli/config/testing`

- `memoryModeStorage`: an in-memory `ModeStorage` whose `dump` shows what was written.
