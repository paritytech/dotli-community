// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Universal Configuration

// The shell is deployed across several root domains (dot.li, paseo.li,
// paseoli.dev, ephemeral previews). `BASE_DOMAIN` derives the
// registrable root from the current hostname and never silently
// defaults to "dot.li", because the cross-origin allow-list (shared
// auth, protocol iframe, SITE_ID) is keyed on this string.
//
// Localhost is a legal dev environment and keeps its explicit
// `"dot.li"` fallback so local runs match the production allow-list.
// Anything else that doesn't parse as a two-segment hostname is a
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

// SiteId is the registrable root domain the shell is running on (e.g. "dot.li",
// "paseo.li", "paseoli.dev"). It is a plain string with no closed union,
// because the codebase is deployed on several root domains including ephemeral
// ones, and a narrow union here would require an unsafe cast at the boundary.
// Validation that a caller may only use the current shell's SiteId lives in
// `@dotli/protocol/auth-storage#isSharedAuthSiteId`, which compares against the
// running `SITE_ID` at runtime.
export type SiteId = string;

export const isLocalhost = isLocalEnv;

export const SITE_ID: SiteId = isLocalhost ? "local.li" : BASE_DOMAIN;

/**
 * True when `origin` is a dApp sandbox origin (`<label>.app.<BASE_DOMAIN>`
 * over https, or `<label>.app.localhost` in dev). The host shell uses this
 * to gate postMessage traffic it receives from the sandbox iframe (loading
 * status, bitswap relay requests) so that only the embedded sandbox — not
 * an arbitrary frame — can drive host-side UI or services.
 */
export function isSandboxOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const { hostname, protocol } = url;
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      return (
        hostname.endsWith(".app.localhost") || hostname === "app.localhost"
      );
    }
    if (protocol !== "https:") {
      return false;
    }
    return hostname.endsWith(`.app.${BASE_DOMAIN}`);
  } catch {
    return false;
  }
}

/**
 * Use the smoldot light client for the statement store chain.
 *
 * Set VITE_SS_USE_SMOLDOT=true to enable. Defaults to false until
 * smoldot statement store support is production-ready, but can be
 * enabled in development for testing and feedback.
 */
export const SS_USE_SMOLDOT =
  (import.meta.env.VITE_SS_USE_SMOLDOT as string | undefined) === "true";

/** Optional relay chain spec override for the statement store people chain.
 *  Value is the chain-spec file name without `.json`, e.g. "westend-local".
 *  When unset, the default Paseo relay chain is reused. */
export const SS_RELAY_CHAIN: string | undefined =
  (import.meta.env.VITE_SS_RELAY_CHAIN as string | undefined) ?? undefined;

// Allow-list polarity: DEBUG is ON only when VITE_APP_DEBUG === "true".
// A negative check such as `!== "false"` would let a typo like "flase",
// "0", or "off" silently enable debug in production builds and flood
// real sessions with debug logs.
export const DEBUG =
  (import.meta.env.VITE_APP_DEBUG as string | undefined) === "true";

// The `.dot` TLD namehash node
export const DOT_NODE =
  "0x3fce7d1364a893e213bc4212792b517ffc88f5b13b86c8ef9c8d390c3a1370ce" as const;

// Derived from the dotNS contracts using OpenZeppelin v5 namespaced storage.
// OZ v5 stores Initializable/OwnableUpgradeable/ERC165 state at hash-derived
// locations, so the contract's own variables start at slot 0.
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

/** Max number of domain archives kept in the SW in-memory LRU cache. */
export const SW_ARCHIVE_CACHE_MAX = 8;

/** Max chain connections per origin on the protocol host. */
export const MAX_CONNECTIONS_PER_ORIGIN = 10;

/** Max nested container bridges per host shell. */
export const MAX_NESTED_BRIDGES = 5;

/** Drop scheduled notifications older than this many ms past `scheduledAt`. */
export const SCHEDULED_NOTIFICATIONS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Max pending scheduled notifications per product. 21st `schedule` returns ScheduleLimitReached. */
export const SCHEDULED_NOTIFICATIONS_PER_PRODUCT_CAP = 20;

/** Polling tick for the scheduler loop. */
export const SCHEDULED_NOTIFICATIONS_POLL_INTERVAL_MS = 1_000;

/** Visibility bias: hidden tabs only fire records older than `now - offset`, giving
 *  a visible tab in the same origin first crack at the lock. */
export const SCHEDULED_NOTIFICATIONS_HIDDEN_TAB_OFFSET_MS = 300;

// Re-exported from the pure-constants `timeouts` sub-module so existing
// `@dotli/config/config` callers keep working unchanged.
export { TIMEOUTS } from "./timeouts";
