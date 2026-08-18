// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Network Configuration

export const NetworkName = {
  PASEO_NEXT_V1: "paseo-next-v1",
  PASEO_NEXT_V2: "paseo-next-v2",
  PREVIEW_NET: "previewnet",
} as const;

export type NetworkName = (typeof NetworkName)[keyof typeof NetworkName];

export type Network = NetworkName;

export interface DotnsStorageSlots {
  readonly REGISTRY_RECORDS: number;
  readonly CONTENTHASH: number;
  readonly TEXT_RECORDS?: number;
}

export interface DotnsContracts {
  readonly DOTNS_REGISTRY: `0x${string}`;
  readonly DOTNS_CONTENT_RESOLVER: `0x${string}`;
  readonly STORAGE_SLOTS: DotnsStorageSlots;
  /** Bare TLD label this network registers names under, e.g. `dot` or `paseo`. */
  readonly TLD: string;
}

export interface ChainService {
  readonly genesis: string;
  readonly rpcs: readonly string[];
  /**
   * How often this chain is expected to produce a block, in milliseconds.
   *
   * Measured rather than assumed, and not derivable at runtime: no single
   * constant yields it for a parachain. `Timestamp.MinimumPeriod` is 0 on all
   * three here, and `Aura.SlotDuration` reads 12000 or 24000 because it is the
   * async-backing slot, not the block time. A parachain's rate is its relay
   * slot divided by its `BLOCK_PROCESSING_VELOCITY`, which is a Rust generic
   * absent from metadata.
   */
  readonly blockTimeMs: number;
}

export interface BulletinService extends ChainService {
  readonly ipfsGateways: readonly string[];
}

export interface ServicesConfig {
  readonly label: string;
  readonly description: string;
  readonly relay: ChainService;
  readonly assethub: ChainService;
  readonly bulletin: BulletinService;
  readonly people: ChainService;
  readonly dotns: DotnsContracts;
}

const BUILTIN_NETWORK_SERVICES: Record<NetworkName, ServicesConfig> = {
  [NetworkName.PASEO_NEXT_V1]: {
    label: "Paseo Next V1",
    description: "Legacy Paseo Next system chains",
    relay: {
      genesis:
        "0x374057be67b355151f271ff70c3db98308c62c8adc48dc6724b6a009a1a014fd",
      rpcs: [
        "wss://paseo-rpc.n.dwellir.com",
        "wss://paseo.dotters.network",
        "wss://paseo.ibp.network",
        "wss://paseo.rpc.amforc.com",
      ],
      blockTimeMs: 6000,
    },
    assethub: {
      genesis:
        "0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2",
      rpcs: [
        "wss://asset-hub-paseo-rpc.n.dwellir.com",
        "wss://asset-hub-paseo.dotters.network",
        "wss://asset-hub-paseo.ibp.network",
        "wss://sys.turboflakes.io/asset-hub-paseo",
      ],
      blockTimeMs: 2000,
    },
    bulletin: {
      genesis:
        "0x744960c32e3a3df5440e1ecd4d34096f1ce2230d7016a5ada8a765d5a622b4ea",
      rpcs: [],
      blockTimeMs: 6000,
      ipfsGateways: ["https://paseo-ipfs.polkadot.io"],
    },
    people: {
      genesis:
        "0xa22a2424d2cbf561eaecf7da8b1b548fa9d1939f60265e942b1049616a012f71",
      rpcs: [],
      blockTimeMs: 2000,
    },
    dotns: {
      DOTNS_REGISTRY: "0x4Da0d37aBe96C06ab19963F31ca2DC0412057a6f",
      DOTNS_CONTENT_RESOLVER: "0x7756DF72CBc7f062e7403cD59e45fBc78bed1cD7",
      STORAGE_SLOTS: { REGISTRY_RECORDS: 0, CONTENTHASH: 1 },
      TLD: "dot",
    },
  },
  [NetworkName.PASEO_NEXT_V2]: {
    label: "Paseo Next V2",
    description: "Upgraded Paseo Next system chains",
    relay: {
      genesis:
        "0x374057be67b355151f271ff70c3db98308c62c8adc48dc6724b6a009a1a014fd",
      rpcs: [
        "wss://paseo-rpc.n.dwellir.com",
        "wss://paseo.dotters.network",
        "wss://paseo.ibp.network",
        "wss://paseo.rpc.amforc.com",
      ],
      blockTimeMs: 6000,
    },
    assethub: {
      genesis:
        "0x23e730eb1c6fecae09c917439a5038cb6122d0d48980e8b9bbf0ff56f94a2ca6",
      rpcs: ["wss://paseo-asset-hub-next-rpc.polkadot.io"],
      blockTimeMs: 2000,
    },
    bulletin: {
      genesis:
        "0x8cfe6717dc4becfda2e13c488a1e2061ff2dfee96e7d031157f72d36716c0a22",
      rpcs: ["wss://paseo-bulletin-next-rpc.polkadot.io"],
      blockTimeMs: 6000,
      ipfsGateways: ["https://paseo-bulletin-next-ipfs.polkadot.io"],
    },
    people: {
      genesis:
        "0x89a63b11fef2c0273fc72c0d864da0793a665dade5db153e0cab995348c5440f",
      rpcs: ["wss://paseo-people-next-system-rpc.polkadot.io"],
      blockTimeMs: 2000,
    },
    dotns: {
      DOTNS_REGISTRY: "0xf34054fd76BbF85f216cf9908226D5f0A72E50CA",
      DOTNS_CONTENT_RESOLVER: "0x7F74D7CD50f5a834270E2ad395a01b01891AB37d",
      STORAGE_SLOTS: { REGISTRY_RECORDS: 0, CONTENTHASH: 0, TEXT_RECORDS: 1 },
      TLD: "paseo",
    },
  },
  [NetworkName.PREVIEW_NET]: {
    label: "Previewnet",
    description: "Product Preview Network",
    relay: {
      genesis:
        "0x8c27ddf678c2ae9bef0efebfc485a9309f3d735c6d3fbb8d947afc3ace0e80f4",
      rpcs: [
        "wss://previewnet.substrate.dev/relay/alice",
        "wss://previewnet.substrate.dev/relay/bob",
      ],
      blockTimeMs: 6000,
    },
    assethub: {
      genesis:
        "0x4d11c803cc6921429e3876638977ad006ea1bba8cd3976a0bca2f164e7026210",
      rpcs: ["wss://previewnet.substrate.dev/asset-hub"],
      blockTimeMs: 2000,
    },
    bulletin: {
      genesis:
        "0x2778b1c94c4362e49a54be57d3056bc714f3712e4486625312704ffb74eb973d",
      rpcs: ["wss://previewnet.substrate.dev/bulletin"],
      blockTimeMs: 6000,
      ipfsGateways: ["https://previewnet.substrate.dev"],
    },
    people: {
      genesis:
        "0x3138c6d4ce58c760047a413c2a930e919b4673a841ab4890de59aac3bd037f3d",
      rpcs: ["wss://previewnet.substrate.dev/people"],
      blockTimeMs: 2000,
    },
    dotns: {
      DOTNS_REGISTRY: "0xf34054fd76BbF85f216cf9908226D5f0A72E50CA",
      DOTNS_CONTENT_RESOLVER: "0x7F74D7CD50f5a834270E2ad395a01b01891AB37d",
      STORAGE_SLOTS: { REGISTRY_RECORDS: 0, CONTENTHASH: 0, TEXT_RECORDS: 1 },
      TLD: "dot",
    },
  },
};

/**
 * Runtime overrides for the tables above, so a deployment can point a network at
 * a locally forked chain without a source edit or a rebuild:
 *
 *   {"enabled":["paseo-next-v2"],
 *    "networks":{"paseo-next-v2":{"label":"My Fork",
 *                "assethub":{"rpcs":["ws://localhost:9944"]}}}}
 *
 * Delivered as `globalThis.__DOTLI_NETWORK__`, set by a blocking classic script
 * that runs before the deferred module bundle, so every reader here stays
 * synchronous and the table can still be built once at module init.
 *
 * Three deliberate limits keep this small and safe:
 *
 *   * **Endpoints only** — `label`, `rpcs` and `ipfsGateways`. Never `genesis` or
 *     `dotns`, which are the trust root for name resolution: an override that
 *     could repoint the DotNS registry would let anything running in the page
 *     redirect every `.dot` lookup while `isVerifiedSession()` still reported
 *     "verified". Limiting it to endpoints means the worst an override can do is
 *     move you to a different node for the *same* chain identity, which the light
 *     client verifies against the compiled-in genesis anyway. It is also why only
 *     documents need this: the protocol SharedWorker reads solely `genesis` and
 *     `dotns`, so it needs no runtime config and none is plumbed to it.
 *   * **Patches existing networks** — no new names, so `NetworkName` stays a
 *     closed union. Use `label` to say what a repointed network really is.
 *   * **Arrays replace, never concatenate.** Appending would leave the fork's
 *     endpoint in a pool alongside the public ones, the client would pick
 *     whichever, and the result works intermittently in a way that is very hard
 *     to diagnose.
 *
 * Suits forked dev chains (zombie-bite and friends): a bitten fork preserves the
 * upstream genesis hash and contract addresses, so endpoints are the only axis
 * that needs to move. Note the smoldot backends sync from chain specs and ignore
 * `rpcs` entirely — overrides take effect under `rpc-gateway`.
 *
 * Anything unrecognised throws rather than being skipped: a silently ignored
 * override means running against the public chain while believing otherwise,
 * which is the failure this exists to prevent. See docs/docker.md.
 */
export interface RuntimeNetworkConfig {
  /** Networks offered in the selector. Overrides `VITE_NETWORKS` when present. */
  readonly enabled?: readonly string[];
  /** Per-network endpoint overrides, merged over the built-in entry. */
  readonly networks?: Record<string, unknown>;
  /**
   * Explicit base domain, for hosts with more than two hostname segments where
   * deriving the registrable root would pick the wrong one. Consumed by
   * `BASE_DOMAIN` in ./config, not here — it is declared on this interface
   * because it travels in the same document.
   */
  readonly baseDomain?: string;
}

const RUNTIME_GLOBAL_KEY = "__DOTLI_NETWORK__";

/**
 * Whether this build accepts runtime config at all. **Off unless explicitly
 * built for it**, which in practice means the Docker image — the hosted
 * deployments have no use for it, so they do not ship the hook. The injecting
 * side is gated separately in `runtime-network-config-plugin.ts`, so neither half
 * alone turns it on.
 */
const RUNTIME_CONFIG_ENABLED =
  ((import.meta as { env?: Record<string, string | undefined> }).env
    ?.VITE_RUNTIME_NETWORK_CONFIG ?? "") === "true";

function readRuntimeConfig(): RuntimeNetworkConfig | null {
  if (!RUNTIME_CONFIG_ENABLED) {
    return null;
  }
  const raw = (globalThis as Record<string, unknown>)[RUNTIME_GLOBAL_KEY];
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `globalThis.${RUNTIME_GLOBAL_KEY} must be an object, got ${
        Array.isArray(raw) ? "an array" : typeof raw
      }.`,
    );
  }
  return raw;
}

/** Reject anything outside `allowed`, naming the valid fields. */
function checkFields(
  patch: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(patch)) {
    if (!allowed.includes(key)) {
      throw new Error(
        `${path}.${key} is not overridable. Valid fields: ${allowed.join(
          ", ",
        )}. genesis and dotns are deliberately fixed at build time.`,
      );
    }
  }
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `${path} must be an object, got ${
        value === null
          ? "null"
          : Array.isArray(value)
            ? "an array"
            : typeof value
      }.`,
    );
  }
  return value as Record<string, unknown>;
}

function asStrings(value: unknown, path: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`${path} must be an array of strings.`);
  }
  return value as readonly string[];
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string.`);
  }
  return value;
}

// The merges below are written out field by field rather than as a generic deep
// merge. With this few fields it is shorter, it cannot walk the prototype chain,
// and the exact set of things an override may reach is legible at a glance —
// note `genesis` and `blockTimeMs` are copied from the built-in and never read
// from the patch.

function mergeChain(
  base: ChainService,
  patch: unknown,
  path: string,
): ChainService {
  const p = asObject(patch, path);
  checkFields(p, ["rpcs"], path);
  return {
    genesis: base.genesis,
    blockTimeMs: base.blockTimeMs,
    rpcs: p.rpcs === undefined ? base.rpcs : asStrings(p.rpcs, `${path}.rpcs`),
  };
}

function mergeBulletin(
  base: BulletinService,
  patch: unknown,
  path: string,
): BulletinService {
  const p = asObject(patch, path);
  checkFields(p, ["rpcs", "ipfsGateways"], path);
  return {
    genesis: base.genesis,
    blockTimeMs: base.blockTimeMs,
    rpcs: p.rpcs === undefined ? base.rpcs : asStrings(p.rpcs, `${path}.rpcs`),
    ipfsGateways:
      p.ipfsGateways === undefined
        ? base.ipfsGateways
        : asStrings(p.ipfsGateways, `${path}.ipfsGateways`),
  };
}

function mergeNetwork(
  base: ServicesConfig,
  patch: unknown,
  path: string,
): ServicesConfig {
  const p = asObject(patch, path);
  checkFields(p, ["label", "relay", "assethub", "bulletin", "people"], path);
  return {
    ...base,
    label:
      p.label === undefined ? base.label : asString(p.label, `${path}.label`),
    relay:
      p.relay === undefined
        ? base.relay
        : mergeChain(base.relay, p.relay, `${path}.relay`),
    assethub:
      p.assethub === undefined
        ? base.assethub
        : mergeChain(base.assethub, p.assethub, `${path}.assethub`),
    bulletin:
      p.bulletin === undefined
        ? base.bulletin
        : mergeBulletin(base.bulletin, p.bulletin, `${path}.bulletin`),
    people:
      p.people === undefined
        ? base.people
        : mergeChain(base.people, p.people, `${path}.people`),
  };
}

function applyNetworkOverrides(
  base: Record<NetworkName, ServicesConfig>,
): Record<NetworkName, ServicesConfig> {
  const patches = readRuntimeConfig()?.networks;
  if (patches === undefined) {
    return base;
  }
  const label = `globalThis.${RUNTIME_GLOBAL_KEY}.networks`;
  const merged = { ...base };
  for (const name of Object.keys(patches)) {
    // `hasOwnProperty.call`, not `in`: JSON.parse yields `__proto__` as an own
    // key, and `in` would accept it as a known network.
    if (!Object.prototype.hasOwnProperty.call(base, name)) {
      throw new Error(
        `${label} targets unknown network "${name}". Valid values: ${Object.keys(
          base,
        ).join(
          ", ",
        )}. Overrides patch existing networks; they cannot add new ones.`,
      );
    }
    const key = name as NetworkName;
    merged[key] = mergeNetwork(base[key], patches[name], `${label}.${name}`);
  }
  return merged;
}

/** Built-in networks with any runtime endpoint overrides applied. */
export const NETWORK_NAME_TO_SERVICES_CONFIG: Record<
  NetworkName,
  ServicesConfig
> = applyNetworkOverrides(BUILTIN_NETWORK_SERVICES);

export const NETWORK_KEY = "dotli:network";

const VALID_NETWORKS: ReadonlySet<string> = new Set<Network>([
  NetworkName.PASEO_NEXT_V1,
  NetworkName.PASEO_NEXT_V2,
  NetworkName.PREVIEW_NET,
]);

/**
 * Networks this deployment offers in the selector.
 *
 * Runtime config's `enabled` list wins when present, so one image can be
 * narrowed to a single network without a rebuild; otherwise the build-time
 * `VITE_NETWORKS` applies. The first entry is the default network.
 */
export function getEnabledNetworks(): Network[] {
  const runtimeEnabled = readRuntimeConfig()?.enabled;
  const source =
    runtimeEnabled !== undefined
      ? {
          label: "the runtime network config's `enabled`",
          entries: runtimeEnabled,
        }
      : {
          label: "VITE_NETWORKS",
          entries: (
            (import.meta as { env?: Record<string, string | undefined> }).env
              ?.VITE_NETWORKS ?? ""
          ).split(","),
        };

  if (runtimeEnabled === undefined && source.entries.join("").trim() === "") {
    throw new Error(
      'VITE_NETWORKS is not set. The deployment must declare a comma-separated list of networks (e.g. "paseo-next-v2,previewnet").',
    );
  }

  const seen = new Set<Network>();
  const parsed: Network[] = [];
  for (const entry of source.entries) {
    const trimmed = entry.trim();
    if (trimmed === "") {
      continue;
    }
    if (!isValidNetwork(trimmed)) {
      throw new Error(
        `${source.label} contains an unknown network "${trimmed}". Valid values: ${[
          ...VALID_NETWORKS,
        ].join(", ")}.`,
      );
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      parsed.push(trimmed);
    }
  }
  if (parsed.length === 0) {
    throw new Error(
      `${source.label} is empty after parsing. Provide at least one valid network.`,
    );
  }
  return parsed;
}

export function defaultNetwork(): Network {
  return getEnabledNetworks()[0];
}
let networkOverride: Network | null = null;

export function isValidNetwork(value: string): value is Network {
  return VALID_NETWORKS.has(value);
}

export function setNetworkOverride(network: Network): void {
  networkOverride = network;
}

export function getNetwork(): Network {
  if (networkOverride !== null) {
    return networkOverride;
  }
  const enabled = getEnabledNetworks();
  try {
    const stored = localStorage.getItem(NETWORK_KEY);
    if (stored !== null && isValidNetwork(stored) && enabled.includes(stored)) {
      return stored;
    }
    const computed = defaultNetwork();
    localStorage.setItem(NETWORK_KEY, computed);
    return computed;
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable (private mode, quota, disabled cookies). Non-fatal by design: readers fall back to defaults, writers drop silently. No metric, noisy on every page load.
  } catch {
    /* localStorage unavailable. Intentionally non-fatal. */
  }
  return defaultNetwork();
}

export function setNetwork(network: Network): void {
  try {
    localStorage.setItem(NETWORK_KEY, network);
    // eslint-disable-next-line no-restricted-syntax
  } catch {
    /* localStorage unavailable */
  }
}

/**
 * The active TLD with its leading dot, e.g. `".paseo"`.
 *
 * Each TLD must also be in `DOTNS_TLDS` in truapi's `truapi-platform`, which
 * gates `productId` with its own hardcoded list. A network whose TLD the core
 * does not know cannot load a product until the core ships it.
 */
export function getActiveTldSuffix(): string {
  return `.${getActiveServicesConfig().dotns.TLD}`;
}

/** Appends the active TLD to a bare label, giving `myapp.paseo`. */
export function withActiveTld(label: string): string {
  return `${label}${getActiveTldSuffix()}`;
}

/** Full service config for the active network. */
export function getActiveServicesConfig(): ServicesConfig {
  return NETWORK_NAME_TO_SERVICES_CONFIG[getNetwork()];
}

/**
 * Genesis hashes that dApps may target on the active network. Used by the
 * protocol bridge to reject unknown chains before dispatching to smoldot.
 */
export function getActiveSupportedGenesisHashes(): Set<string> {
  const cfg = getActiveServicesConfig();
  return new Set(
    [
      cfg.relay.genesis,
      cfg.assethub.genesis,
      cfg.bulletin.genesis,
      cfg.people.genesis,
    ].map((h) => h.toLowerCase()),
  );
}

/**
 * Chains advertised to sandboxed dApps in **RPC-gateway** mode: the curated
 * system chains that have configured WSS RPC endpoints. The Bulletin chain is
 * intentionally excluded because its content is served through IPFS gateways.
 * This list controls feature advertisement, not access control: the shared
 * Rust-core connection callback also serves core-owned Bulletin operations.
 *
 * Single source of truth shared by the host's chain-support advertisement
 * (`isRemoteChainSupported`) and the gateway provider factory
 * (`createRpcChainProvider`).
 */
/**
 * The four chains this app runs, named by what they do for the visitor.
 *
 * `ServicesConfig` already implies exactly this set by having exactly these
 * four fields. Naming it lets a popover row, its status and its block history
 * share one key, where today rows are keyed by genesis hash and sync state by
 * the resolver's own `ChainKey`. Config cannot import the resolver, so
 * `ChainKey` deliberately stays out of here.
 */
export const CHAIN_ROLES = ["relay", "assethub", "bulletin", "people"] as const;
export type ChainRole = (typeof CHAIN_ROLES)[number];

/** What the visitor is told each chain is for. */
export const CHAIN_ROLE_LABELS: Record<ChainRole, string> = {
  relay: "Relay",
  assethub: "General",
  bulletin: "Storage",
  people: "Identity",
};

export interface ActiveChainRole {
  readonly role: ChainRole;
  readonly label: string;
  readonly genesis: string;
  readonly blockTimeMs: number;
  /** False when the active network has no endpoint for this chain. */
  readonly hasEndpoint: boolean;
}

/** Every chain of the active network, in the order a visitor should read them. */
export function getActiveChainRoles(): ActiveChainRole[] {
  const cfg = getActiveServicesConfig();
  return CHAIN_ROLES.map((role) => {
    const service = cfg[role];
    return {
      role,
      label: CHAIN_ROLE_LABELS[role],
      genesis: service.genesis,
      blockTimeMs: service.blockTimeMs,
      hasEndpoint: service.rpcs.length > 0,
    };
  });
}

/** Which role a genesis hash belongs to, or null when it is not ours. */
export function chainRoleForGenesis(genesisHash: string): ChainRole | null {
  const key = genesisHash.toLowerCase();
  const cfg = getActiveServicesConfig();
  return (
    CHAIN_ROLES.find((role) => cfg[role].genesis.toLowerCase() === key) ?? null
  );
}

export function getActiveGatewayChains(): ChainService[] {
  const cfg = getActiveServicesConfig();
  return [cfg.relay, cfg.assethub, cfg.people].filter((c) => c.rpcs.length > 0);
}

/** Genesis hashes (lowercased) advertised to dApps in RPC-gateway mode. */
export function getActiveGatewaySupportedGenesisHashes(): Set<string> {
  return new Set(getActiveGatewayChains().map((c) => c.genesis.toLowerCase()));
}

/** Gateway chains accepted by the shared Rust-core connection callback. */
export function getActiveCoreGatewayChains(): ChainService[] {
  const cfg = getActiveServicesConfig();
  return [...getActiveGatewayChains(), cfg.bulletin].filter(
    (chain) => chain.rpcs.length > 0,
  );
}
