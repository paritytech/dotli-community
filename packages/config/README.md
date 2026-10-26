# `@dotli/config`

Build-time and runtime configuration for dotli: the environment, networks, chain services, the settings a user picks and
timeouts.

## Responsibility

- Owns the network table (dotNS contracts, chain services, TLD) and the active network choice.
- Owns the local roots, which a page and the local servers both read.
- Owns the backend and cache settings, their storage keys and the URL form that carries them to another origin.
- Does not own the host to sandbox wire, logging, metrics or storage of product data.

## Design

- The base domain and site id come from the hostname, and `DEBUG` from the build environment. A base domain is never
  defaulted silently, since the cross-origin allowlist is keyed on it.
- `localhost` and `local.host` are the local roots. A page under either is local, and its root stands for the root
  domain wherever a page builds or checks a sibling origin. `local.host` is a public name, so only a development build
  trusts it, and a production build takes it for any other domain.
- The network table holds per-network service config. The active network is part of the settings, which the protocol
  frame and the sandbox set from their URL.
- Backend (`smoldot-direct`, `smoldot-shared-worker`, `rpc-gateway`) and cache switches are settings beside the network.
  One pure function resolves them from the link, the cross-subdomain store and this origin's storage. A page sets its
  settings once at boot and the getters return them. A change reloads the page, so nothing sets them after. The resolver
  also says when the shared light client was chosen and this browser runs the per-tab one instead.
- A chain is named by its role (`relay`, `assethub`, `bulletin`, `people`) everywhere: the network table, sync events,
  the light client's database outcomes and the UI. A genesis hash maps to its role from the fixed config, so a worker
  that never sees the runtime network config may read it.
- The `./fixed` entry holds only what reads no overridable field, so a worker that never receives the runtime network
  config imports it and never the bare entry.
- Settings travel between origins as URL params. Default values are stripped, so a clean URL means every axis is at its
  default.

## Public API

### `@dotli/config`

- Environment: `BASE_DOMAIN`, `SITE_ID`, `DEBUG`, `DEV_HOST_PORT`, `DEV_PROTOCOL_PORT`, `DEV_SANDBOX_PORT`, `LOCAL_ROOT`
  (the page's local root, or `null` when deployed), `isLocalhost` (whether it has one), `isSandboxOrigin`, `TIMEOUTS`,
  the waits more than one package keeps in step.
- Origins: `hostPlace(hostname, root)` (the root or a subdomain is the `site`, `app.` and below a product, anything else
  `foreign`), `localRootOf(hostname, dev)`, the local root a host sits under or `null`, among the roots a build trusts
  (the page's own build unless `dev` says), for the checks that admit dotli's own pages.
  `isSiteOrigin(origin, baseDomain, dev)`, whether an origin is dotli's own page: the root or a subdomain, never a
  product, over https unless under a trusted local root.
- Networks: `NetworkName`, `getNetwork`, `getEnabledNetworks`, `defaultNetwork` (the first enabled one),
  `getActiveServicesConfig`, `getActiveTldSuffix`, `withActiveTld`, the chain role helpers (`CHAIN_ROLES`,
  `chainRoleForGenesis`, `getActiveChainRoles`) and the gateway and genesis hash readers.
- Settings: `getSettings`, `setSettings`, `subscribeSettings`, `getBackend`, `parseBackend`, `getCacheSettings`,
  `isSharedWorkerAvailable`, `isVerifiedSession`, `parseSettingsFromSearch`, `writeSettingsToSearch`, `resolveSettings`,
  `setActiveNetwork`, `writeLocalSettings`, `sharedSettingsOf`, `hasStoredSettings`, `ResolvedSettings`, `Settings`,
  `SharedSettings`.

### `@dotli/config/fixed`

What a context that never receives the runtime network config may read: `DEBUG`, `CHAIN_ROLES`, `ChainRole`,
`chainRoleForGenesis`, `getActiveFixedServicesConfig`, `FixedServicesConfig`, `getActiveSupportedGenesisHashes`,
`isValidNetwork`, `Network`. A name joins only once it reads no overridable field.

### `@dotli/config/local-roots`

`LOCAL_ROOTS`, the roots the local servers answer under, `LOOPBACK_ROOT`, the loopback one among them, and
`trustedLocalRoots(dev)`, the ones a build takes for the root domain: `local.host` only in a development build, as it is
a public name. It imports nothing, so a page, a build config and a script Node runs directly all load it.

### `@dotli/config/networks`

The network table for Node tooling, which cannot load the bare entry: `NETWORK_NAME_TO_SERVICES_CONFIG`, `NetworkName`,
`isValidNetwork`, `Network`. It reads no page state at load.
