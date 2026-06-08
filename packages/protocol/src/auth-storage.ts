import { BASE_DOMAIN, SITE_ID, type SiteId } from "@dotli/config/config";
import type { ProtocolRequestMethod } from "./messages";

export type SharedAuthRequestMethod =
  | "authHasSession"
  | "authStorageRead"
  | "authStorageWrite"
  | "authStorageClear";

export const SHARED_AUTH_SESSION_KEY = "SsoSessions";

// SCALE-encoded empty `Vec<Session>`: a single length byte of 0. Keep this in
// sync with the core session list encoding so an empty session list does not
// make the host report a stored SSO session.
const EMPTY_SHARED_AUTH_SESSION_LIST = "0x00";

const SHARED_AUTH_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const SHARED_AUTH_METHODS = new Set<ProtocolRequestMethod>([
  "authHasSession",
  "authStorageRead",
  "authStorageWrite",
  "authStorageClear",
]);

export function isSharedAuthRequestMethod(
  method: ProtocolRequestMethod,
): method is SharedAuthRequestMethod {
  return SHARED_AUTH_METHODS.has(method);
}

/**
 * Shared auth sessions are scoped to the registrable root domain the shell is
 * running on. Each host iframe only accepts requests whose siteId equals its
 * own `SITE_ID`, so:
 *   - `host.dot.li`         → only siteId `"dot.li"`
 *   - `host.paseo.li`       → only siteId `"paseo.li"`
 *   - `host.paseoli.dev`    → only siteId `"paseoli.dev"`
 *   - `host.localhost:5173` → only siteId `"local.li"`
 *
 * This guarantees sessions are never shared across unrelated root domains
 * (e.g. dot.li ↔ paseo.li) and trivially tolerates new deployment domains
 * without hard-coding an allowlist.
 */
export function isSharedAuthSiteId(value: string): value is SiteId {
  return value === SITE_ID;
}

export function isSharedAuthStorageKey(key: string): boolean {
  return SHARED_AUTH_KEY_PATTERN.test(key);
}

export function buildSharedAuthStorageKey(siteId: SiteId, key: string): string {
  return `PAPP_${siteId}_${key}`;
}

export function hasStoredSharedAuthSession(value: string | null): boolean {
  return (
    value !== null && value !== "" && value !== EMPTY_SHARED_AUTH_SESSION_LIST
  );
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
