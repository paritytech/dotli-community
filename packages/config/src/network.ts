// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export const NetworkName = {
  PASEO: 'paseo-next-v2',
  PREVIEWNET: 'previewnet',
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
   * Expected block interval. Measured, because no runtime constant yields it for a parachain: `Aura.SlotDuration` is
   * the async-backing slot, and `BLOCK_PROCESSING_VELOCITY` is absent from metadata.
   */
  readonly blockTimeMs: number;
}

export interface BulletinService extends ChainService {
  readonly ipfsGateways: readonly string[];
  /** Host-private HOP endpoints; never inferred from ordinary chain RPC URLs. */
  readonly hopEndpoints?: readonly string[];
}

export interface ServicesConfig {
  readonly label: string;
  readonly description: string;
  readonly identityBackendBaseUrl: string;
  readonly relay: ChainService;
  readonly assethub: ChainService;
  readonly bulletin: BulletinService;
  readonly people: ChainService;
  /** Trusted People-chain Coinage asset; absent where payments are not configured. */
  readonly coinage?: {
    readonly instanceId: number;
    readonly symbol: string;
    readonly decimals: number;
  };
  readonly dotns: DotnsContracts;
}

const BUILTIN_NETWORK_SERVICES: Record<NetworkName, ServicesConfig> = {
  [NetworkName.PASEO]: {
    label: 'Paseo',
    description: 'Paseo Next Network',
    // Same-origin proxy to https://identity.dotspark.app/api/v1.
    identityBackendBaseUrl: '/__dotli-identity/paseo',
    relay: {
      genesis: '0x374057be67b355151f271ff70c3db98308c62c8adc48dc6724b6a009a1a014fd',
      rpcs: [
        'wss://paseo-rpc.n.dwellir.com',
        'wss://paseo.dotters.network',
        'wss://paseo.ibp.network',
        'wss://paseo.rpc.amforc.com',
      ],
      blockTimeMs: 6000,
    },
    assethub: {
      genesis: '0x4349b00e54897e21196fd331015fc5be0f14e118beb0375ed2bb1793737bb57a',
      rpcs: ['wss://paseo-asset-hub-next-rpc.polkadot.io'],
      blockTimeMs: 2000,
    },
    bulletin: {
      genesis: '0x8cfe6717dc4becfda2e13c488a1e2061ff2dfee96e7d031157f72d36716c0a22',
      rpcs: ['wss://paseo-bulletin-next-rpc.polkadot.io'],
      blockTimeMs: 6000,
      ipfsGateways: ['https://paseo-bulletin-next-ipfs.polkadot.io'],
      hopEndpoints: ['wss://paseo-hop-next-0.polkadot.io', 'wss://paseo-hop-next-1.polkadot.io'],
    },
    people: {
      genesis: '0x4a2b5b737de1da59e209b0000a876ec2fa20035dc34fd292a848da32d255ad48',
      rpcs: ['wss://paseo-people-next-system-rpc.polkadot.io'],
      blockTimeMs: 2000,
    },
    coinage: { instanceId: 0, symbol: 'pUSD', decimals: 6 },
    dotns: {
      DOTNS_REGISTRY: '0xf34054fd76BbF85f216cf9908226D5f0A72E50CA',
      DOTNS_CONTENT_RESOLVER: '0x7F74D7CD50f5a834270E2ad395a01b01891AB37d',
      STORAGE_SLOTS: { REGISTRY_RECORDS: 0, CONTENTHASH: 0, TEXT_RECORDS: 1 },
      TLD: 'paseo',
    },
  },
  [NetworkName.PREVIEWNET]: {
    label: 'Previewnet',
    description: 'Product Preview Network',
    // Same-origin proxy to https://identity-previewnet.dotspark.app/api/v1.
    identityBackendBaseUrl: '/__dotli-identity/testnet',
    relay: {
      genesis: '0x860145753657e73c29b9388ffa0a8aebc643ea87434b4b271b6c3c3cc9e6bf92',
      rpcs: ['wss://previewnet.substrate.dev/relay/alice', 'wss://previewnet.substrate.dev/relay/bob'],
      blockTimeMs: 6000,
    },
    assethub: {
      genesis: '0xbac97e23fc8f4bccae72a98f8aeb2bcab20bf755862304e4b46ad6473456e896',
      rpcs: ['wss://previewnet.substrate.dev/asset-hub'],
      blockTimeMs: 2000,
    },
    bulletin: {
      genesis: '0xa081192b90c1f6a3f8e9ce7b2a8246f41af805c66456c84e05fd97c2b3502425',
      rpcs: ['wss://previewnet.substrate.dev/bulletin'],
      blockTimeMs: 6000,
      ipfsGateways: ['https://previewnet.substrate.dev'],
    },
    people: {
      genesis: '0x55e3e689ecfa9d2fffcf7d309b8011956671493982230bfd0420c683542249e9',
      rpcs: ['wss://previewnet.substrate.dev/people'],
      blockTimeMs: 2000,
    },
    dotns: {
      DOTNS_REGISTRY: '0xf34054fd76BbF85f216cf9908226D5f0A72E50CA',
      DOTNS_CONTENT_RESOLVER: '0x7F74D7CD50f5a834270E2ad395a01b01891AB37d',
      STORAGE_SLOTS: { REGISTRY_RECORDS: 0, CONTENTHASH: 0, TEXT_RECORDS: 1 },
      TLD: 'testnet',
    },
  },
};

/**
 * Runtime overrides for the tables above, set by a blocking script so every reader stays synchronous.
 * - Endpoints only. `genesis` and `dotns` are the trust root for name resolution, so an override can only move to
 *   another node of the same chain.
 * - Identity backends receive public account proofs, never wallet entropy. Registration still verifies chain
 *   ownership, not HTTP acceptance. Root-relative proxy paths, HTTPS and loopback HTTP are allowed.
 * - Patches existing networks, so `NetworkName` stays a closed union.
 * - Arrays replace, never concatenate, so a fork's endpoint is never pooled with public ones.
 * The smoldot backends sync from chain specs and ignore `rpcs`. Anything unrecognised throws, because a silently
 * ignored override means running against the public chain.
 */
export interface RuntimeNetworkConfig {
  /** Networks offered in the selector. Overrides `VITE_NETWORKS` when present. */
  readonly enabled?: readonly string[];
  /** Per-network endpoint overrides, merged over the built-in entry. */
  readonly networks?: Record<string, unknown>;
  /** Consumed by `BASE_DOMAIN` in ./config, declared here because it travels in the same document. */
  readonly baseDomain?: string;
}

const RUNTIME_GLOBAL_KEY = '__DOTLI_NETWORK__';

/**
 * Off unless built for it (the Docker image). The injecting side is gated separately, so neither half alone enables it.
 */
const RUNTIME_CONFIG_ENABLED =
  ((import.meta as { env?: Partial<ImportMetaEnv> }).env?.VITE_RUNTIME_NETWORK_CONFIG ?? '') === 'true';

function readRuntimeConfig(): RuntimeNetworkConfig | null {
  if (!RUNTIME_CONFIG_ENABLED) {
    return null;
  }
  const raw = (globalThis as Record<string, unknown>)[RUNTIME_GLOBAL_KEY];
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `globalThis.${RUNTIME_GLOBAL_KEY} must be an object, got ${Array.isArray(raw) ? 'an array' : typeof raw}.`,
    );
  }
  return raw;
}

function checkFields(patch: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(patch)) {
    if (!allowed.includes(key)) {
      throw new Error(
        `${path}.${key} is not overridable. Valid fields: ${allowed.join(
          ', ',
        )}. genesis and dotns are deliberately fixed at build time.`,
      );
    }
  }
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      `${path} must be an object, got ${value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value}.`,
    );
  }
  return value as Record<string, unknown>;
}

function asStrings(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new Error(`${path} must be an array of strings.`);
  }
  return value as readonly string[];
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string.`);
  }
  return value;
}

function asIdentityBackendUrl(value: unknown, path: string): string {
  const raw = asString(value, path);
  const relative = raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\');
  const url = relative ? new URL(raw, 'https://dotli.invalid') : new URL(raw);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(
      `${path} must be a root-relative proxy path or HTTPS base URL (HTTP only on loopback), without credentials, query or fragment.`,
    );
  }
  return (relative ? url.pathname : url.toString()).replace(/\/+$/, '');
}

// Field by field rather than a deep merge, so nothing walks the prototype chain and what an override can reach stays
// legible. `genesis` and `blockTimeMs` are never read from the patch.

function mergeChain(base: ChainService, patch: unknown, path: string): ChainService {
  const p = asObject(patch, path);
  checkFields(p, ['rpcs'], path);
  return {
    genesis: base.genesis,
    blockTimeMs: base.blockTimeMs,
    rpcs: p['rpcs'] === undefined ? base.rpcs : asStrings(p['rpcs'], `${path}.rpcs`),
  };
}

function mergeBulletin(base: BulletinService, patch: unknown, path: string): BulletinService {
  const p = asObject(patch, path);
  checkFields(p, ['rpcs', 'ipfsGateways'], path);
  return {
    genesis: base.genesis,
    blockTimeMs: base.blockTimeMs,
    rpcs: p['rpcs'] === undefined ? base.rpcs : asStrings(p['rpcs'], `${path}.rpcs`),
    ipfsGateways:
      p['ipfsGateways'] === undefined ? base.ipfsGateways : asStrings(p['ipfsGateways'], `${path}.ipfsGateways`),
    ...(base.hopEndpoints === undefined ? {} : { hopEndpoints: base.hopEndpoints }),
  };
}

function mergeNetwork(base: ServicesConfig, patch: unknown, path: string): ServicesConfig {
  const p = asObject(patch, path);
  checkFields(p, ['label', 'identityBackendBaseUrl', 'relay', 'assethub', 'bulletin', 'people'], path);
  return {
    ...base,
    label: p['label'] === undefined ? base.label : asString(p['label'], `${path}.label`),
    identityBackendBaseUrl:
      p['identityBackendBaseUrl'] === undefined
        ? base.identityBackendBaseUrl
        : asIdentityBackendUrl(p['identityBackendBaseUrl'], `${path}.identityBackendBaseUrl`),
    relay: p['relay'] === undefined ? base.relay : mergeChain(base.relay, p['relay'], `${path}.relay`),
    assethub:
      p['assethub'] === undefined ? base.assethub : mergeChain(base.assethub, p['assethub'], `${path}.assethub`),
    bulletin:
      p['bulletin'] === undefined ? base.bulletin : mergeBulletin(base.bulletin, p['bulletin'], `${path}.bulletin`),
    people: p['people'] === undefined ? base.people : mergeChain(base.people, p['people'], `${path}.people`),
  };
}

function applyNetworkOverrides(base: Record<NetworkName, ServicesConfig>): Record<NetworkName, ServicesConfig> {
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
        `${label} targets unknown network "${name}". Valid values: ${Object.keys(base).join(
          ', ',
        )}. Overrides patch existing networks; they cannot add new ones.`,
      );
    }
    const key = name as NetworkName;
    merged[key] = mergeNetwork(base[key], patches[name], `${label}.${name}`);
  }
  return merged;
}

/** Built-in networks with any runtime endpoint overrides applied. */
export const NETWORK_NAME_TO_SERVICES_CONFIG: Record<NetworkName, ServicesConfig> =
  applyNetworkOverrides(BUILTIN_NETWORK_SERVICES);

export const NETWORK_KEY = 'dotli:network';

const VALID_NETWORKS: ReadonlySet<string> = new Set<Network>([NetworkName.PASEO, NetworkName.PREVIEWNET]);

/**
 * Networks offered in the selector, from runtime `enabled` when present, else `VITE_NETWORKS`. The first is the
 * default.
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
          label: 'VITE_NETWORKS',
          entries: ((import.meta as { env?: Partial<ImportMetaEnv> }).env?.VITE_NETWORKS ?? '').split(','),
        };

  if (runtimeEnabled === undefined && source.entries.join('').trim() === '') {
    throw new Error(
      'VITE_NETWORKS is not set. The deployment must declare a comma-separated list of networks (e.g. "paseo-next-v2,previewnet").',
    );
  }

  const seen = new Set<Network>();
  const parsed: Network[] = [];
  for (const entry of source.entries) {
    const trimmed = entry.trim();
    if (trimmed === '') {
      continue;
    }
    if (!isValidNetwork(trimmed)) {
      throw new Error(
        `${source.label} contains an unknown network "${trimmed}". Valid values: ${[...VALID_NETWORKS].join(', ')}.`,
      );
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      parsed.push(trimmed);
    }
  }
  if (parsed.length === 0) {
    throw new Error(`${source.label} is empty after parsing. Provide at least one valid network.`);
  }
  return parsed;
}

export function defaultNetwork(): Network {
  const [first] = getEnabledNetworks();
  if (first === undefined) {
    throw new Error('No enabled networks; expected at least one.');
  }
  return first;
}
let networkOverride: Network | null = null;

export function isValidNetwork(value: string): value is Network {
  return VALID_NETWORKS.has(value);
}

export function setNetworkOverride(network: Network): void {
  networkOverride = network;
}

function storedNetwork(enabled: readonly Network[]): Network | null {
  const stored = localStorage.getItem(NETWORK_KEY);
  return stored !== null && isValidNetwork(stored) && enabled.includes(stored) ? stored : null;
}

/**
 * The network as this page can tell it before settings apply, from the URL's `fromUrl`, then localStorage, then the
 * default. Unlike getNetwork it writes nothing, as settings tell a fresh visit from a stored choice by what is stored.
 */
export function peekNetwork(fromUrl: Network | null): Network {
  if (networkOverride !== null) {
    return networkOverride;
  }
  const enabled = getEnabledNetworks();
  if (fromUrl !== null && enabled.includes(fromUrl)) {
    return fromUrl;
  }
  try {
    return storedNetwork(enabled) ?? defaultNetwork();
  } catch {
    // localStorage is unavailable, where getNetwork falls back to the default too.
    return defaultNetwork();
  }
}

export function getNetwork(): Network {
  if (networkOverride !== null) {
    return networkOverride;
  }
  try {
    const stored = storedNetwork(getEnabledNetworks());
    if (stored !== null) {
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
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable, and the write is best effort.
  } catch {
    /* localStorage unavailable */
  }
}

/**
 * The active TLD with its leading dot.
 * Each TLD must also be in truapi-platform's `DOTNS_TLDS`, or the core cannot load a product under it.
 */
export function getActiveTldSuffix(): string {
  return getTldSuffix(getNetwork());
}

/** The TLD `network` registers names under, with its leading dot. */
export function getTldSuffix(network: Network): string {
  return `.${NETWORK_NAME_TO_SERVICES_CONFIG[network].dotns.TLD}`;
}

/** Appends the active TLD to a bare label, giving `myapp.paseo`. */
export function withActiveTld(label: string): string {
  return `${label}${getActiveTldSuffix()}`;
}

export function getActiveServicesConfig(): ServicesConfig {
  return NETWORK_NAME_TO_SERVICES_CONFIG[getNetwork()];
}

/** Genesis hashes dApps may target on the active network. */
export function getActiveSupportedGenesisHashes(): Set<string> {
  const cfg = getActiveServicesConfig();
  return new Set(
    [cfg.relay.genesis, cfg.assethub.genesis, cfg.bulletin.genesis, cfg.people.genesis].map(h => h.toLowerCase()),
  );
}

/**
 * The four chains, named by what they do for the visitor, so a popover row, its status and block history share a key.
 * Config cannot import the resolver, so its `ChainKey` stays out of here.
 */
export const CHAIN_ROLES = ['relay', 'assethub', 'bulletin', 'people'] as const;
export type ChainRole = (typeof CHAIN_ROLES)[number];

/** What the visitor is told each chain is for. */
export const CHAIN_ROLE_LABELS: Record<ChainRole, string> = {
  relay: 'Relay',
  assethub: 'Hub',
  bulletin: 'Storage',
  people: 'Identity',
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
  return CHAIN_ROLES.map(role => {
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
  return CHAIN_ROLES.find(role => cfg[role].genesis.toLowerCase() === key) ?? null;
}

/**
 * Chains advertised to dApps in rpc-gateway mode. Bulletin is excluded because its content is served through IPFS
 * gateways. This is advertisement, not access control.
 */
export function getActiveGatewayChains(): ChainService[] {
  const cfg = getActiveServicesConfig();
  return [cfg.relay, cfg.assethub, cfg.people].filter(c => c.rpcs.length > 0);
}

/** Genesis hashes (lowercased) advertised to dApps in RPC-gateway mode. */
export function getActiveGatewaySupportedGenesisHashes(): Set<string> {
  return new Set(getActiveGatewayChains().map(c => c.genesis.toLowerCase()));
}

/** Genesis hashes (lowercased) the core gateway seam can serve. */
export function getActiveCoreGatewaySupportedGenesisHashes(): Set<string> {
  return new Set(getActiveCoreGatewayChains().map(c => c.genesis.toLowerCase()));
}

/** Gateway chains accepted by the shared Rust-core connection callback. */
export function getActiveCoreGatewayChains(): ChainService[] {
  const cfg = getActiveServicesConfig();
  return [...getActiveGatewayChains(), cfg.bulletin].filter(chain => chain.rpcs.length > 0);
}
