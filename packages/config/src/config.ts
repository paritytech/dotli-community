// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Universal Configuration

// The shell is deployed across several root domains (dot.li, paseo.li,
// paseoli.dev, ephemeral previews). `BASE_DOMAIN` derives the
// registrable root from the current hostname and never silently
// defaults to "dot.li", because the cross-origin allowlist (shared
// auth, protocol iframe, SITE_ID) is keyed on this string.
//
// Localhost is a legal dev environment and keeps its explicit
// `"dot.li"` fallback so local runs match the production allowlist.
// Anything else that doesn't parse as a two-segment hostname is a
// deployment misconfiguration and aborts boot rather than opening the
// allowlist to the wrong origin.
const hostname = self.location.hostname;
const segments = hostname.split(".");
const isLocalEnv =
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "127.0.0.1";

/**
 * Explicit base domain from runtime config, for deployments whose hostname has
 * more than two segments.
 *
 * Deriving the registrable root works for `dot.li` and `paseo.li`, but a
 * deployment at `dotli.ppn-65iw.pdp-stg-scw.parity.io` would derive `parity.io`
 * and then look for its protocol iframe at `host.parity.io` — the wrong origin
 * entirely, with `isSandboxOrigin` accepting `*.app.parity.io` to match. Such
 * hosts must state their base domain instead of having it inferred.
 *
 * Read from the same blocking-script global as the network config
 * (see `RuntimeNetworkConfig` in ./network), so it lands before the module
 * bundle runs and `BASE_DOMAIN` can stay a plain const. Gated on the same
 * build-time flag: a build that does not opt into runtime config ignores this,
 * so the hosted deployments keep deriving as before.
 *
 * Must be at least two segments and a suffix of the current hostname. Without
 * the suffix check, a page could declare any base domain and widen the
 * cross-origin allowlist to a host it has nothing to do with.
 */
function configuredBaseDomain(): string | null {
  const enabled =
    ((import.meta as { env?: Record<string, string | undefined> }).env
      ?.VITE_RUNTIME_NETWORK_CONFIG ?? "") === "true";
  if (!enabled) {
    return null;
  }
  const raw = (globalThis as Record<string, unknown>).__DOTLI_NETWORK__;
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const candidate = (raw as { baseDomain?: unknown }).baseDomain;
  if (candidate === undefined) {
    return null;
  }
  if (typeof candidate !== "string" || candidate.split(".").length < 2) {
    throw new Error(
      `[dot.li config] Runtime baseDomain must be a hostname of at least two segments, got ${JSON.stringify(candidate)}.`,
    );
  }
  if (hostname !== candidate && !hostname.endsWith(`.${candidate}`)) {
    throw new Error(
      `[dot.li config] Runtime baseDomain "${candidate}" is not a suffix of the current hostname "${hostname}". Refusing to boot: this would key the cross-origin allowlist on a domain this page is not served from.`,
    );
  }
  return candidate;
}

function deriveBaseDomain(): string {
  const configured = configuredBaseDomain();
  if (configured !== null) {
    return configured;
  }
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
 * Exact sandbox origin for a validated DotNS label in this deployment.
 *
 * Keep this shared by iframe construction and host-side message
 * authorization so those two boundaries cannot drift.
 */
export function sandboxOriginForLabel(label: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
    throw new Error(`invalid sandbox label: ${label}`);
  }
  if (isLocalhost) {
    const port = import.meta.env.DEV ? "5174" : self.location.port;
    return `http://${label}.app.localhost${port === "" ? "" : `:${port}`}`;
  }
  return `https://${label}.app.${BASE_DOMAIN}`;
}

/** Optional relay chain spec override for the statement store people chain.
 *  Value is the chain-spec file name without `.json`, e.g. "westend-local".
 *  When unset, the default Paseo relay chain is reused. */
export const SS_RELAY_CHAIN: string | undefined =
  (import.meta.env.VITE_SS_RELAY_CHAIN as string | undefined) ?? undefined;

// Allowlist polarity: DEBUG is ON only when VITE_APP_DEBUG === "true".
export const DEBUG =
  (import.meta.env.VITE_APP_DEBUG as string | undefined) === "true";

/** Max number of domain archives kept in the SW in-memory LRU cache. */
export const SW_ARCHIVE_CACHE_MAX = 8;

/** Max chain connections per origin on the protocol host. */
export const MAX_CONNECTIONS_PER_ORIGIN = 10;

/** Drop scheduled notifications older than this many ms past `scheduledAt`. */
export const SCHEDULED_NOTIFICATIONS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Max pending scheduled notifications per product. 21st `schedule` returns ScheduleLimitReached. */
export const SCHEDULED_NOTIFICATIONS_PER_PRODUCT_CAP = 20;

/** Polling tick for the scheduler loop. */
export const SCHEDULED_NOTIFICATIONS_POLL_INTERVAL_MS = 1_000;

/** Visibility bias: hidden tabs only fire records older than `now - offset`, giving
 *  a visible tab in the same origin first crack at the lock. */
export const SCHEDULED_NOTIFICATIONS_HIDDEN_TAB_OFFSET_MS = 300;

// Re-exported from the pure-constants `timeouts` submodule, so existing
// `@dotli/config/config` callers keep working unchanged.
export { TIMEOUTS } from "./timeouts";
