// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { hostPlace, localRootOf } from './host-place.js';

// BASE_DOMAIN never defaults silently, because the cross-origin allowlist (shared auth, protocol iframe, SITE_ID) is
// keyed on it. A local root falls back to "dot.li" to match production, any other unparsable hostname aborts boot.
// Astro's build-time render has no location and derives as localhost.
const hostname = import.meta.env.SSR ? 'localhost' : self.location.hostname;
const segments = hostname.split('.');

/**
 * The local root this page is served under, which stands for the root domain, or `null` when deployed. A page on the
 * loopback address reaches its sibling origins under `localhost`.
 */
export const LOCAL_ROOT: string | null = localRootOf(hostname) ?? (hostname === '127.0.0.1' ? 'localhost' : null);

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
  if (LOCAL_ROOT !== null) {
    return 'dot.li';
  }
  if (segments.length < 2) {
    throw new Error(
      `[dot.li config] Refusing to boot: hostname "${hostname}" doesn't have a two-segment registrable root. Set up a proper DNS entry or run from localhost.`,
    );
  }
  return segments.slice(-2).join('.');
}

export const BASE_DOMAIN = deriveBaseDomain();

// A plain string, not a union, because deployments include ephemeral root domains. `isSharedAuthSiteId` validates it
// at runtime.
export type SiteId = string;

export const isLocalhost = LOCAL_ROOT !== null;

export const SITE_ID: SiteId = isLocalhost ? 'local.li' : BASE_DOMAIN;

// Under `npm run dev` each origin is its own dev server, where a build serves all three from one port.

/** The host's dev server port. */
export const DEV_HOST_PORT = '4001';
/** The sandbox's dev server port. */
export const DEV_SANDBOX_PORT = '4002';
/** The protocol frame's dev server port. */
export const DEV_PROTOCOL_PORT = '4003';

/**
 * Whether `origin` is a sandbox origin, so only the embedded sandbox and not an arbitrary frame drives host services.
 */
export function isSandboxOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const { hostname, protocol } = url;
    const root = localRootOf(hostname);
    if (root !== null) {
      return hostPlace(hostname, root) === 'app';
    }
    if (protocol !== 'https:') {
      return false;
    }
    // A deployed sandbox is served only on a product's own `<label>.app.<root>`. The shell serves `app.<root>` itself,
    // so that host is never a sandbox.
    return hostname.endsWith(`.app.${BASE_DOMAIN}`);
  } catch {
    return false;
  }
}

export const DEBUG = import.meta.env.VITE_APP_DEBUG === 'true';
