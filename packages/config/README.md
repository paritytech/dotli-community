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
- The network table holds per-network service config. The active network comes from stored settings and may be
  overridden at runtime with `setNetworkOverride`.
- Backend (`smoldot-direct`, `smoldot-shared-worker`, `rpc-gateway`) and cache switches live in a mode store. Storage is
  reached through a `ModeStorage` set with `configureModeStorage`, so logic runs without a page. Defaults are seeded
  once at boot, before the shared mode store hydrates.
- A chain is named by its role (`relay`, `assethub`, `bulletin`, `people`) everywhere: the network table, sync events,
  the light client's database outcomes and the UI. A genesis hash maps to its role from the fixed config, so a worker
  that never sees the runtime network config may read it.
- Settings travel between origins as URL params. Default values are stripped, so a clean URL means every axis is at its
  default.

## Public API

### `@dotli/config`

- Environment: `BASE_DOMAIN`, `SITE_ID`, `DEBUG`, `DEV_PROTOCOL_PORT`, `DEV_SANDBOX_PORT`, `isLocalhost`,
  `isSandboxOrigin`, `BLOCK_CACHE_MAX_BYTES`, the `SCHEDULED_NOTIFICATIONS_*` limits, `TIMEOUTS`.
- Networks: `NetworkName`, `getNetwork`, `setNetwork`, `setNetworkOverride`, `getEnabledNetworks`,
  `getActiveServicesConfig`, `getActiveFixedServicesConfig`, `getActiveTldSuffix`, `withActiveTld`, the chain role
  helpers (`CHAIN_ROLES`, `chainRoleForGenesis`, `getActiveChainRoles`) and the gateway and genesis hash readers.
- Settings: `getBackend`, `setBackend`, `getCacheSettings`, `setCacheSettings`, `configureModeStorage`,
  `isSharedWorkerAvailable`, `isVerifiedSession`, `persistDefaults`, `parseSettingsFromSearch`, `writeSettingsToSearch`.

### `@dotli/config/testing`

- `memoryModeStorage`: an in-memory `ModeStorage` whose `dump` shows what was written.
