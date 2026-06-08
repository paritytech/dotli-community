// dot.li Universal Viewer — Configuration
// Contract addresses, chain config, peer multiaddrs, and minimal ABIs.

// The shell is deployed across several root domains (dot.li, paseo.li,
// paseoli.dev, ephemeral previews). `BASE_DOMAIN` derives the
// registrable root from the current hostname — never silently defaulted
// to "dot.li" — because the cross-origin allow-list (shared auth,
// protocol iframe, SITE_ID) is keyed on this string.
//
// Localhost is a legal dev environment and keeps its explicit
// `"dot.li"` fallback so local runs match the production allow-list;
// anything else that doesn't parse as a two-segment hostname is a
// deploy misconfiguration and aborts boot rather than opening the
// allow-list to the wrong origin.
const hostname = self.location.hostname;
const segments = hostname.split(".");
const isLocalEnv =
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "127.0.0.1";

function deriveBaseDomain(): string {
  if (isLocalEnv) {
    return "dot.li";
  }
  if (segments.length < 2) {
    throw new Error(
      `[dot.li config] Refusing to boot — hostname "${hostname}" doesn't have a two-segment registrable root. Set up a proper DNS entry or run from localhost.`,
    );
  }
  return `${segments[segments.length - 2]}.${segments[segments.length - 1]}`;
}

export const BASE_DOMAIN = deriveBaseDomain();

// --- Site identity -------------------------------------------------------

// SiteId is the registrable root domain the shell is running on (e.g. "dot.li",
// "paseo.li", "paseoli.dev"). It is a plain string — there is no closed union,
// because the codebase is deployed on several root domains including ephemeral
// ones, and a narrow union here would require an unsafe cast at the boundary.
// Validation that a caller may only use the current shell's SiteId lives in
// `@dotli/protocol/auth-storage#isSharedAuthSiteId`, which compares against the
// running `SITE_ID` at runtime.
export type SiteId = string;

export const isLocalhost = isLocalEnv;

export const SITE_ID: SiteId = isLocalhost ? "local.li" : BASE_DOMAIN;

// --- Statement store provider --------------------------------------------

/** Use smoldot light client for the statement store chain (default: false).
 *  Set VITE_SS_USE_SMOLDOT=true to enable.
 *  Default is false for now until all dependencies to make statement
 *  store support in smoldot production-ready are in place, but can be
 *  enabled in development for testing and feedback. */
export const SS_USE_SMOLDOT =
  (import.meta.env.VITE_SS_USE_SMOLDOT as string | undefined) === "true";

/** Which people chain spec to use for the statement store via smoldot.
 *  Value is the chain-spec file name without `.json`, e.g.
 *  "people-westend-local" or "next-people-paseo".
 *
 *  Hard-coded — the active deployment targets Paseo and every other
 *  network-scoped constant (Asset Hub RPC, relay genesis, bulletin peers)
 *  lives here, not in env. When the network flips we'll change this
 *  string alongside the rest, as a single deliberate commit instead of
 *  a per-environment deploy knob. */
export const SS_PEOPLE_CHAIN = "next-people-paseo";

/** Optional relay chain spec override for the statement store people chain.
 *  Value is the chain-spec file name without `.json`, e.g. "westend-local".
 *  When unset, the default Paseo relay chain is reused. */
export const SS_RELAY_CHAIN: string | undefined =
  (import.meta.env.VITE_SS_RELAY_CHAIN as string | undefined) ?? undefined;

// --- Debug logging -------------------------------------------------------
//
// Allow-list polarity: DEBUG is ON only when VITE_APP_DEBUG === "true".
// The previous `!== "false"` check had the wrong sign — a typo like
// "flase" / "0" / "off" would silently enable debug in production
// builds and flood real sessions with debug logs.

export const DEBUG =
  (import.meta.env.VITE_APP_DEBUG as string | undefined) === "true";

// --- Well-known genesis hashes (Paseo testnet) ---

export const PASEO_RELAY_GENESIS =
  "0x77afd6190f1554ad45fd0d31aee62aacc33c6db0ea801129acb813f913e0764f" as const;
export const ASSET_HUB_PASEO_GENESIS =
  "0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2" as const;
export const BULLETIN_PASEO_GENESIS =
  "0x744960c32e3a3df5440e1ecd4d34096f1ce2230d7016a5ada8a765d5a622b4ea" as const;
export const PEOPLE_PASEO_GENESIS =
  "0xa22a2424d2cbf561eaecf7da8b1b548fa9d1939f60265e942b1049616a012f71" as const;

export const SUPPORTED_GENESIS_HASHES = new Set<string>([
  PASEO_RELAY_GENESIS,
  ASSET_HUB_PASEO_GENESIS,
  BULLETIN_PASEO_GENESIS,
  PEOPLE_PASEO_GENESIS,
]);

// --- dotNS Contracts on Asset Hub Paseo (Revive EVM pallet) ---

export const CONTRACTS = {
  DOTNS_REGISTRY: "0x4Da0d37aBe96C06ab19963F31ca2DC0412057a6f" as const,
  DOTNS_CONTENT_RESOLVER: "0x7756DF72CBc7f062e7403cD59e45fBc78bed1cD7" as const,
};

// The `.dot` TLD namehash node
export const DOT_NODE =
  "0x3fce7d1364a893e213bc4212792b517ffc88f5b13b86c8ef9c8d390c3a1370ce" as const;

// --- Solidity storage slot numbers for direct storage reads ---
// Derived from the dotNS contracts using OpenZeppelin v5 (ERC-7201 namespaced
// storage). OZ v5 stores Initializable/OwnableUpgradeable/ERC165 state at
// hash-derived locations, so the contract's own variables start at slot 0.
//
// DotnsRegistry layout (own variables only):
//   slot 0: records  mapping(bytes32 => Record{address owner, address resolver, bool exists})
//   slot 1: registrarController
//   slot 2: dotnsRegistrar
//   slot 3: reverseResolver
//   slot 4: storeFactory
//
// DotnsContentResolver layout (own variables only):
//   slot 0: registry (address)
//   slot 1: contenthashes  mapping(bytes32 => bytes)
//   slot 2: textRecords
//   slot 3: operators
export const STORAGE_SLOTS = {
  /** DotnsRegistry: mapping(bytes32 => Record) at slot 0 */
  REGISTRY_RECORDS: 0,
  /** DotnsContentResolver: mapping(bytes32 => bytes) at slot 1 */
  CONTENTHASH: 1,
} as const;

// --- Bulletin Chain — Peer multiaddrs for Helia P2P ---
//
// The active peer set MUST match the resolver chain genesis. Mixing Paseo
// and Westend peers would let Helia dial both networks via
// `Promise.allSettled`, racing across networks and succeeding against
// whichever happened to have the CID first — a violation of "user picks
// one path, we use that path".
//
// `BULLETIN_PEERS` (the active default) is Paseo-only, matching
// `ASSET_HUB_PASEO_GENESIS` below. The per-network constants stay for
// documentation and for the future endpoint-picker UI; they are *not* the
// active default.

export const BULLETIN_PEERS_PASEO = [
  "/dns4/paseo-bulletin-collator-node-0.parity-testnet.parity.io/tcp/443/wss/p2p/12D3KooWRuKisocQ2Z5hBZagV5YGxJMYuW13xT42sUiUCWf5bRtu",
  "/dns4/paseo-bulletin-collator-node-1.parity-testnet.parity.io/tcp/443/wss/p2p/12D3KooWSgdX2egCUiXtDUNV6hGh6JrtTb9vQ6iRfFMdnTemQDDp",
  "/dns4/paseo-bulletin-rpc-node-0.polkadot.io/tcp/443/wss/p2p/12D3KooWG7dt8yAMBaNrWh5juvHMGvJtPKTCaS87kkadWZKpV7ox",
  "/dns4/paseo-bulletin-rpc-node-1.polkadot.io/tcp/443/wss/p2p/12D3KooWSS9QNRiLGBoZrDrtXvPyBV7QrV7F3A1V8f6xAXECSnj5",
];

export const BULLETIN_PEERS_WESTEND = [
  "/dns4/westend-bulletin-rpc-node-0.polkadot.io/tcp/443/wss/p2p/12D3KooWGb3sdXpdQPvL1wwHYHpQpMAEWxpgNNb6sndHmCByMXZw",
  "/dns4/westend-bulletin-rpc-node-1.polkadot.io/tcp/443/wss/p2p/12D3KooWN8hBVUWXNiur1w6EiEPkTJibbzpagZmm4cphMxWLv9yc",
  "/dns4/westend-bulletin-collator-node-0.parity-testnet.parity.io/tcp/443/wss/p2p/12D3KooWSxYQRoTT9rZNZRrjCfG2fPpBwPumkQsxLroTKjX6Mvkw",
  "/dns4/westend-bulletin-collator-node-1.parity-testnet.parity.io/tcp/443/wss/p2p/12D3KooWSD5tovFkmja9aFYA6QM8eU3mFhZKdAuCsa5MgSsNDmxc",
];

export const BULLETIN_PEERS = BULLETIN_PEERS_PASEO;

// --- IPFS Gateway ---

/** IPFS gateway for content fetching in gateway mode */
export const IPFS_GATEWAY = "https://paseo-ipfs.polkadot.io";

// --- Asset Hub Paseo JSON-RPC endpoints (gateway mode) ---
export const PASEO_RELAY_RPC = [
  "wss://paseo-rpc.n.dwellir.com",
  "wss://paseo.dotters.network",
  "wss://paseo.ibp.network",
  "wss://paseo.rpc.amforc.com",
];

export const ASSET_HUB_PASEO_RPC = [
  "wss://asset-hub-paseo-rpc.n.dwellir.com",
  "wss://asset-hub-paseo.dotters.network",
  "wss://asset-hub-paseo.ibp.network",
  "wss://sys.turboflakes.io/asset-hub-paseo",
];

// --- SW archive cache ---
/** Max number of domain archives kept in the SW in-memory LRU cache. */
export const SW_ARCHIVE_CACHE_MAX = 8;

/** Max chain connections per origin on the protocol host. */
export const MAX_CONNECTIONS_PER_ORIGIN = 3;

// --- Timeouts (ms) ---
// Re-exported from the pure-constants `timeouts` sub-module so existing
// `@dotli/config/config` callers keep working unchanged.
export { TIMEOUTS } from "./timeouts";
