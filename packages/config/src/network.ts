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

export const NETWORK_NAME_TO_SERVICES_CONFIG: Record<
  NetworkName,
  ServicesConfig
> = {
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
    },
    bulletin: {
      genesis:
        "0x744960c32e3a3df5440e1ecd4d34096f1ce2230d7016a5ada8a765d5a622b4ea",
      rpcs: [],
      ipfsGateways: ["https://paseo-ipfs.polkadot.io"],
    },
    people: {
      genesis:
        "0xa22a2424d2cbf561eaecf7da8b1b548fa9d1939f60265e942b1049616a012f71",
      rpcs: [],
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
    },
    assethub: {
      genesis:
        "0x23e730eb1c6fecae09c917439a5038cb6122d0d48980e8b9bbf0ff56f94a2ca6",
      rpcs: ["wss://paseo-asset-hub-next-rpc.polkadot.io"],
    },
    bulletin: {
      genesis:
        "0x8cfe6717dc4becfda2e13c488a1e2061ff2dfee96e7d031157f72d36716c0a22",
      rpcs: ["wss://paseo-bulletin-next-rpc.polkadot.io"],
      ipfsGateways: ["https://paseo-bulletin-next-ipfs.polkadot.io"],
    },
    people: {
      genesis:
        "0x89a63b11fef2c0273fc72c0d864da0793a665dade5db153e0cab995348c5440f",
      rpcs: ["wss://paseo-people-next-system-rpc.polkadot.io"],
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
    },
    assethub: {
      genesis:
        "0x4d11c803cc6921429e3876638977ad006ea1bba8cd3976a0bca2f164e7026210",
      rpcs: ["wss://previewnet.substrate.dev/asset-hub"],
    },
    bulletin: {
      genesis:
        "0x2778b1c94c4362e49a54be57d3056bc714f3712e4486625312704ffb74eb973d",
      rpcs: ["wss://previewnet.substrate.dev/bulletin"],
      ipfsGateways: ["https://previewnet.substrate.dev"],
    },
    people: {
      genesis:
        "0x3138c6d4ce58c760047a413c2a930e919b4673a841ab4890de59aac3bd037f3d",
      rpcs: ["wss://previewnet.substrate.dev/people"],
    },
    dotns: {
      DOTNS_REGISTRY: "0xf34054fd76BbF85f216cf9908226D5f0A72E50CA",
      DOTNS_CONTENT_RESOLVER: "0x7F74D7CD50f5a834270E2ad395a01b01891AB37d",
      STORAGE_SLOTS: { REGISTRY_RECORDS: 0, CONTENTHASH: 0, TEXT_RECORDS: 1 },
      TLD: "dot",
    },
  },
};

export const NETWORK_KEY = "dotli:network";

const VALID_NETWORKS: ReadonlySet<string> = new Set<Network>([
  NetworkName.PASEO_NEXT_V1,
  NetworkName.PASEO_NEXT_V2,
  NetworkName.PREVIEW_NET,
]);

/**
 * Networks this deployment supports, set at build time via the required
 * `VITE_NETWORKS` env var.
 */
export function getEnabledNetworks(): Network[] {
  const raw = (import.meta as { env?: Record<string, string | undefined> }).env
    ?.VITE_NETWORKS;
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      'VITE_NETWORKS is not set. The deployment must declare a comma-separated list of networks (e.g. "paseo-next-v2,previewnet").',
    );
  }
  const seen = new Set<Network>();
  const parsed: Network[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") {
      continue;
    }
    if (!isValidNetwork(trimmed)) {
      throw new Error(
        `VITE_NETWORKS contains an unknown network "${trimmed}". Valid values: ${[
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
      "VITE_NETWORKS is empty after parsing. Provide at least one valid network.",
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

/** Bare TLD label for the active network, e.g. `"paseo"` on Paseo Next V2. */
export function getActiveTld(): string {
  return getActiveServicesConfig().dotns.TLD;
}

/** The active TLD with its leading dot, e.g. `".paseo"`. */
export function getActiveTldSuffix(): string {
  return `.${getActiveTld()}`;
}

/** `"myapp"` → `"myapp.paseo"`. An already-suffixed name is returned unchanged. */
export function withActiveTld(label: string): string {
  return label.toLowerCase().endsWith(getActiveTldSuffix())
    ? label
    : `${label}${getActiveTldSuffix()}`;
}

/** `"myapp.paseo"` → `"myapp"`. A name without the suffix is returned unchanged. */
export function stripActiveTld(name: string): string {
  const suffix = getActiveTldSuffix();
  return name.toLowerCase().endsWith(suffix)
    ? name.slice(0, -suffix.length)
    : name;
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
