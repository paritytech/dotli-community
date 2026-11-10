# `@dotli/config`

Build-time and runtime configuration: the environment, networks, chain services, user settings and timeouts.

## Responsibility

- **Owns** the network table (dotNS contracts, chain services, TLD) and the active network.
- **Owns** the local roots, read by pages and the local servers.
- **Owns** the backend and cache settings, their storage keys and their URL form.
- **Does not own** the host to sandbox wire, logging, metrics or product data storage.

## Design

- **Base domain:** comes from the hostname and is never defaulted silently. The cross-origin allowlist is keyed on it.
- **Local roots:** `localhost` and `local.host` stand for the root domain. `local.host` is a public name, so only a
  development build trusts it.
- **Runtime config:** a build made for it reads a global that a blocking script sets. It may override endpoints, the
  enabled networks and `baseDomain`. A bad value stops the boot, since an ignored override would run against the public
  chain.
- **Settings:** the network, the backend (`smoldot-direct`, `smoldot-shared-worker`, `rpc-gateway`) and cache switches.
  A page resolves them once at boot. A change reloads the page.
- **Backend facts:** ask what a backend can do (`hasLightClient`), never compare its name.
- **Chain roles:** a chain is named by its role (`relay`, `assethub`, `bulletin`, `people`) everywhere.
- **URL form:** settings travel between origins as URL params. Defaults are stripped, so a clean URL means defaults.
- **Fixed entry:** a worker never receives the runtime config, so it imports `./fixed`, never the bare entry.

## Public API

### `@dotli/config`

| Export                                                                                         | What it does                  |
| ---------------------------------------------------------------------------------------------- | ----------------------------- |
| `BASE_DOMAIN`, `SITE_ID`, `SiteId`, `DEBUG`, `TIMEOUTS`                                        | Environment and shared waits. |
| `DEV_HOST_PORT`, `DEV_PROTOCOL_PORT`, `DEV_SANDBOX_PORT`                                       | Dev server ports.             |
| `LOCAL_ROOT`, `isLocalhost`, `getLocalRoot`                                                    | Local roots.                  |
| `getHostPlace`, `isSiteOrigin`, `isSandboxOrigin`                                              | What an origin is.            |
| `NETWORK_NAMES`, `Network`, `isValidNetwork`, `NETWORK_KEY`, `NETWORK_NAME_TO_SERVICES_CONFIG` | The network table.            |
| `getNetwork`, `getEnabledNetworks`, `getDefaultNetwork`, `setActiveNetwork`                    | The active network.           |
| `getActiveServicesConfig`, `getActiveTldSuffix`, `withActiveTld`                               | Its services and TLD.         |
| `getActiveSupportedGenesisHashes`, `getActiveGatewaySupportedGenesisHashes`                    | Genesis hashes for products.  |
| `getActiveCoreGatewayChains`, `getActiveCoreGatewaySupportedGenesisHashes`                     | Core gateway chains.          |
| `CHAIN_ROLES`, `ChainRole`, `CHAIN_ROLE_LABELS`, `getChainRoleForGenesis`                      | Chain roles.                  |
| `getActiveChainRoles`, `ActiveChainRole`                                                       | The active network's chains.  |
| `ChainService`, `FixedChainService`, `FixedServicesConfig`, `DotnsContracts`                   | Network table types.          |
| `getSettings`, `setSettings`, `subscribeSettings`                                              | The context's settings.       |
| `resolveSettings`, `ResolvedSettings`, `Settings`, `SettingsSources`                           | Resolves settings at boot.    |
| `getSharedSettings`, `SharedSettings`, `hasStoredSettings`, `writeLocalSettings`               | Stored settings.              |
| `parseSettingsFromSearch`, `writeSettingsToSearch`, `ParsedUrlSettings`                        | Settings in URL params.       |
| `getBackend`, `parseBackend`, `Backend`, `BACKEND_KEY`, `BACKEND_FACTS`                        | The backend setting.          |
| `hasLightClient`, `hasSharedWorker`, `isVerifiedSession`, `isSharedWorkerAvailable`            | What a backend can do.        |
| `getCacheSettings`, `CacheSettings`, `CACHE_KEY`                                               | Cache switches.               |

### `@dotli/config/fixed`

For a context without the runtime config. A name joins only once it reads no overridable field.

`DEBUG`, `CHAIN_ROLES`, `ChainRole`, `getChainRoleForGenesis`, `getActiveFixedServicesConfig`, `FixedServicesConfig`,
`getActiveSupportedGenesisHashes`, `isValidNetwork`, `Network`.

### `@dotli/config/local-roots`

Imports nothing, so pages, build configs and Node scripts load it.

`LOCAL_ROOTS`, `LOOPBACK_ROOT`, `getTrustedLocalRoots(dev)`.

### `@dotli/config/networks`

The network table for Node tooling. Reads no page state.

`NETWORK_NAME_TO_SERVICES_CONFIG`, `NETWORK_NAMES`, `isValidNetwork`, `Network`.
