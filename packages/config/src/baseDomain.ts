// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getLocalRoot } from './getLocalRoot.js';
import { readRuntimeNetworkConfig } from './readRuntimeNetworkConfig.js';

// A plain string, not a union, because deployments include ephemeral root domains. `isSharedAuthSiteId` validates it
// at runtime.
export type SiteId = string;

// BASE_DOMAIN never defaults silently, because the cross-origin allowlist (shared auth, protocol iframe, SITE_ID) is
// keyed on it. A local root falls back to "dot.li" to match production, any other unparsable hostname aborts boot.
// Astro's build-time render has no location and derives as localhost.
const hostname = import.meta.env.SSR ? 'localhost' : self.location.hostname;
const segments = hostname.split('.');

/**
 * The local root this page is served under, which stands for the root domain, or `null` when deployed. A page on the
 * loopback address reaches its sibling origins under `localhost`.
 */
export const LOCAL_ROOT: string | null = getLocalRoot(hostname) ?? (hostname === '127.0.0.1' ? 'localhost' : null);

export const BASE_DOMAIN = deriveBaseDomain();

export const isLocalhost = LOCAL_ROOT !== null;

export const SITE_ID: SiteId = isLocalhost ? 'local.li' : BASE_DOMAIN;

function deriveBaseDomain(): string {
  const configured = getConfiguredBaseDomain();
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

/**
 * Runtime base domain for hosts with more than two segments, which would otherwise derive the wrong root.
 * Must be a suffix of the hostname, or a page could widen the cross-origin allowlist to an unrelated host.
 */
function getConfiguredBaseDomain(): string | null {
  const candidate = readRuntimeNetworkConfig()?.baseDomain;
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
