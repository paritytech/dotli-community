// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// BASE_DOMAIN never defaults silently, because the cross-origin allowlist (shared auth, protocol iframe, SITE_ID) is
// keyed on it. Localhost falls back to "dot.li" to match production, any other unparsable hostname aborts boot.
// Astro's build-time render has no location and derives as localhost.
const hostname = import.meta.env.SSR ? 'localhost' : self.location.hostname;
const segments = hostname.split('.');
const isLocalEnv = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1';

/**
 * Runtime base domain for hosts with more than two segments, which would otherwise derive the wrong root.
 * Must be a suffix of the hostname, or a page could widen the cross-origin allowlist to an unrelated host.
 */
function configuredBaseDomain(): string | null {
  const enabled = ((import.meta as { env?: Partial<ImportMetaEnv> }).env?.VITE_RUNTIME_NETWORK_CONFIG ?? '') === 'true';
  if (!enabled) {
    return null;
  }
  const raw = (globalThis as Record<string, unknown>)['__DOTLI_NETWORK__'];
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const candidate = (raw as { baseDomain?: unknown }).baseDomain;
  if (candidate === undefined) {
    return null;
  }
  if (typeof candidate !== 'string' || candidate.split('.').length < 2) {
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
    return 'dot.li';
  }
  if (segments.length < 2) {
    throw new Error(
      `[dot.li config] Refusing to boot — hostname "${hostname}" doesn't have a two-segment registrable root. Set up a proper DNS entry or run from localhost.`,
    );
  }
  return segments.slice(-2).join('.');
}

export const BASE_DOMAIN = deriveBaseDomain();

// A plain string, not a union, because deployments include ephemeral root domains. `isSharedAuthSiteId` validates it
// at runtime.
export type SiteId = string;

export const isLocalhost = isLocalEnv;

export const SITE_ID: SiteId = isLocalhost ? 'local.li' : BASE_DOMAIN;

/**
 * Under `npm run dev` each origin is its own dev server, where a build serves all three from one port. Must match
 * `server.port` in apps/sandbox and apps/protocol.
 */
export const DEV_SANDBOX_PORT = '4322';
export const DEV_PROTOCOL_PORT = '4323';

/**
 * Whether `origin` is a sandbox origin, so only the embedded sandbox and not an arbitrary frame drives host services.
 */
export function isSandboxOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const { hostname, protocol } = url;
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      return hostname.endsWith('.app.localhost') || hostname === 'app.localhost';
    }
    if (protocol !== 'https:') {
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
    const port = import.meta.env.DEV ? '5174' : self.location.port;
    return `http://${label}.app.localhost${port === '' ? '' : `:${port}`}`;
  }
  return `https://${label}.app.${BASE_DOMAIN}`;
}

// Allowlist polarity: DEBUG is ON only when VITE_APP_DEBUG === "true".
export const DEBUG = import.meta.env.VITE_APP_DEBUG === 'true';

/** Content block cache cap. After each load the least recently used blocks are dropped until it fits. */
export const BLOCK_CACHE_MAX_BYTES = 256 * 1024 * 1024;

/** Drop scheduled notifications older than this many ms past `scheduledAt`. */
export const SCHEDULED_NOTIFICATIONS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Pending scheduled notifications per product before `schedule` returns ScheduleLimitReached. */
export const SCHEDULED_NOTIFICATIONS_PER_PRODUCT_CAP = 20;

export const SCHEDULED_NOTIFICATIONS_POLL_INTERVAL_MS = 1_000;

/** Hidden tabs fire only records older than `now - offset`, giving a visible tab first crack at the lock. */
export const SCHEDULED_NOTIFICATIONS_HIDDEN_TAB_OFFSET_MS = 300;

export { TIMEOUTS } from './timeouts.js';
