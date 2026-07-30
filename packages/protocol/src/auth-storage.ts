// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { BASE_DOMAIN, SITE_ID, type SiteId } from "@dotli/config/config";
import type { ProtocolRequestMethod } from "./messages";

export type SharedAuthRequestMethod =
  | "authStorageRead"
  | "authStorageWrite"
  | "authStorageClear";

export type SharedModeRequestMethod =
  | "modeStorageRead"
  | "modeStorageWrite"
  | "modeStorageClear";

export const SHARED_CORE_SESSION_KEY = "session";
const LEGACY_SHARED_AUTH_SESSION_KEY = "SsoSessionsV3";

// Both the shared-auth and shared-mode stores accept the same key shape, an
// alphanumeric token with dots, underscores, colons and dashes. Keep the
// regex shared so the validation contract is one thing. A future store
// needing a different shape should get its own constant.
const SHARED_STORAGE_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const SHARED_AUTH_METHODS = new Set<ProtocolRequestMethod>([
  "authStorageRead",
  "authStorageWrite",
  "authStorageClear",
]);
const SHARED_MODE_METHODS = new Set<ProtocolRequestMethod>([
  "modeStorageRead",
  "modeStorageWrite",
  "modeStorageClear",
]);

export function isSharedAuthRequestMethod(
  method: ProtocolRequestMethod,
): method is SharedAuthRequestMethod {
  return SHARED_AUTH_METHODS.has(method);
}

export function isSharedModeRequestMethod(
  method: ProtocolRequestMethod,
): method is SharedModeRequestMethod {
  return SHARED_MODE_METHODS.has(method);
}

/**
 * Shared auth sessions are scoped to the registrable root domain the shell is
 * running on. Each host iframe only accepts requests whose siteId equals its
 * own `SITE_ID`, so:
 *   - `host.dot.li` accepts only siteId `"dot.li"`
 *   - `host.paseo.li` accepts only siteId `"paseo.li"`
 *   - `host.paseoli.dev` accepts only siteId `"paseoli.dev"`
 *   - `host.localhost:5173` accepts only siteId `"local.li"`
 *
 * This guarantees sessions are never shared across unrelated root domains
 * (e.g. dot.li and paseo.li) and trivially tolerates new deployment domains
 * without hard-coding an allowlist.
 */
export function isSharedAuthSiteId(value: string): value is SiteId {
  return value === SITE_ID;
}

/**
 * Validate a caller-supplied shared-auth key (e.g. `SsoSessions`). This is
 * the *raw* key. The namespaced form produced by `buildSharedAuthStorageKey`
 * is for use against `localStorage`, not for this check.
 */
export function isValidSharedAuthKey(key: string): boolean {
  return SHARED_STORAGE_KEY_PATTERN.test(key);
}

export function buildSharedAuthStorageKey(siteId: SiteId, key: string): string {
  return `TRUAPI_${siteId}_${key}`;
}

/** Storage key used by the removed Nova host runtime. Its session encoding is
 * incompatible with TrUAPI, so the protocol host deletes this key at boot.
 *
 * TODO(remove-legacy-nova): this cleanup is gated on returning browsers, not
 * product migration. Delete it (with `LEGACY_SHARED_AUTH_SESSION_KEY` above
 * and `clearLegacySharedAuthSession` in `apps/protocol/src/main.ts`) once stale
 * `PAPP_*` keys in long-lived browser profiles are no longer a concern. */
export function buildLegacySharedAuthSessionStorageKey(siteId: SiteId): string {
  return `PAPP_${siteId}_${LEGACY_SHARED_AUTH_SESSION_KEY}`;
}

/**
 * Shared mode-storage keys use a separate prefix from auth so the two stores
 * cannot collide. The validation pattern is identical. Caller-supplied keys
 * are caller-controlled but always namespaced under the prefix here.
 */
export function buildSharedModeStorageKey(siteId: SiteId, key: string): string {
  return `DOTLI_MODE_${siteId}_${key}`;
}

/**
 * Validate a caller-supplied shared-mode key (e.g. `dotli:chain-backend`).
 * As with `isValidSharedAuthKey`, this is the *raw* key.
 */
export function isValidSharedModeKey(key: string): boolean {
  return SHARED_STORAGE_KEY_PATTERN.test(key);
}

export function isSharedAuthOriginAllowed(origin: string): boolean {
  try {
    const url = new URL(origin);
    const { hostname, protocol } = url;

    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      return (
        hostname !== "app.localhost" && !hostname.endsWith(".app.localhost")
      );
    }

    if (protocol !== "https:") {
      return false;
    }

    if (hostname === BASE_DOMAIN || hostname === `host.${BASE_DOMAIN}`) {
      return true;
    }

    return (
      hostname !== `app.${BASE_DOMAIN}` &&
      hostname.endsWith(`.${BASE_DOMAIN}`) &&
      !hostname.endsWith(`.app.${BASE_DOMAIN}`)
    );
  } catch {
    return false;
  }
}
