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
  readonly storageSlots: DotnsStorageSlots;
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
        "0x77afd6190f1554ad45fd0d31aee62aacc33c6db0ea801129acb813f913e0764f",
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
      storageSlots: { REGISTRY_RECORDS: 0, CONTENTHASH: 1 },
    },
  },
  [NetworkName.PASEO_NEXT_V2]: {
    label: "Paseo Next V2",
    description: "Upgraded Paseo Next system chains",
    relay: {
      genesis:
        "0x77afd6190f1554ad45fd0d31aee62aacc33c6db0ea801129acb813f913e0764f",
      rpcs: [
        "wss://paseo-rpc.n.dwellir.com",
        "wss://paseo.dotters.network",
        "wss://paseo.ibp.network",
        "wss://paseo.rpc.amforc.com",
      ],
    },
    assethub: {
      genesis:
        "0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f",
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
        "0xc5af1826b31493f08b7e2a823842f98575b806a784126f28da9608c68665afa5",
      rpcs: ["wss://paseo-people-next-system-rpc.polkadot.io"],
    },
    dotns: {
      DOTNS_REGISTRY: "0xa1b2b939E82b2ecE55Bd8a0E283818BfC1CA6CDc",
      DOTNS_CONTENT_RESOLVER: "0x8A26480b0B5Df3d4D9b95adc24a5Ecb33A5b8F64",
      storageSlots: { REGISTRY_RECORDS: 0, CONTENTHASH: 0, TEXT_RECORDS: 1 },
    },
  },
  [NetworkName.PREVIEW_NET]: {
    label: "Previewnet",
    description: "Product Preview Network",
    relay: {
      genesis:
        "0x946053e2be0d883a5ae3de0394a683c63e3b1b3b98848feb721b1b127bd4aaf4",
      rpcs: [
        "wss://previewnet.substrate.dev/relay/alice",
        "wss://previewnet.substrate.dev/relay/bob",
      ],
    },
    assethub: {
      genesis:
        "0x29f7b15e6227f86b90bf5199b5c872c28649a30e5f15fae6dd8fa9d5d48d6fbb",
      rpcs: ["wss://previewnet.substrate.dev/asset-hub"],
    },
    bulletin: {
      genesis:
        "0xf37fa1f1450ea120edbf64c3fc447f671a00e1f1095a698f42eeec073c7ee487",
      rpcs: ["wss://previewnet.substrate.dev/bulletin"],
      ipfsGateways: ["https://previewnet.substrate.dev"],
    },
    people: {
      genesis:
        "0x3389bc9179d3be32568c67278bd080d05631ac71982d28a3fe545421147b311e",
      rpcs: ["wss://previewnet.substrate.dev/people"],
    },
    dotns: {
      DOTNS_REGISTRY: "0x5622CA75C75726Da13ae46C69127C07c87538633",
      DOTNS_CONTENT_RESOLVER: "0xBD003d5Dd04E68aC60d529a46AEfBdEf8941868C",
      storageSlots: { REGISTRY_RECORDS: 0, CONTENTHASH: 0, TEXT_RECORDS: 1 },
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
    if (stored !== null && isValidNetwork(stored)) {
      // Migrate previously-selected V1 to V2 while V1 is disabled in the UI.
      const migrated =
        stored === NetworkName.PASEO_NEXT_V1
          ? NetworkName.PASEO_NEXT_V2
          : stored;
      if (enabled.includes(migrated)) {
        if (migrated !== stored) {
          localStorage.setItem(NETWORK_KEY, migrated);
        }
        return migrated;
      }
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
 * Chains a sandboxed dApp can reach in **RPC-gateway** mode: the curated
 * system chains that have configured WSS RPC endpoints. The Bulletin chain is
 * intentionally excluded even when it has an RPC - its content is served
 * through IPFS gateways, not a chain RPC connection - so gateway mode never
 * advertises it as a connectable dApp chain.
 *
 * Single source of truth shared by the host's chain-support advertisement
 * (`isRemoteChainSupported`) and the gateway provider factory
 * (`createRpcChainProvider`).
 */
export function getActiveGatewayChains(): ChainService[] {
  const cfg = getActiveServicesConfig();
  return [cfg.relay, cfg.assethub, cfg.people].filter((c) => c.rpcs.length > 0);
}

/** Genesis hashes (lowercased) a dApp can reach in RPC-gateway mode. */
export function getActiveGatewaySupportedGenesisHashes(): Set<string> {
  return new Set(getActiveGatewayChains().map((c) => c.genesis.toLowerCase()));
}
