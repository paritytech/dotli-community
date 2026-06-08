import { BASE_DOMAIN, SITE_ID, type SiteId } from "@dotli/config/config";
import type { ProtocolRequestMethod } from "./messages";

export type SharedAuthRequestMethod =
  | "authStorageRead"
  | "authStorageWrite"
  | "authStorageClear";

export const SHARED_CORE_SESSION_KEY = "session";

const SHARED_AUTH_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const SHARED_AUTH_METHODS = new Set<ProtocolRequestMethod>([
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
 * Shared host-origin session storage is scoped to the registrable root domain
 * the shell is running on. Each host iframe only accepts requests whose siteId
 * equals its own `SITE_ID`, so:
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
  return key === SHARED_CORE_SESSION_KEY || SHARED_AUTH_KEY_PATTERN.test(key);
}

export function buildSharedAuthStorageKey(siteId: SiteId, key: string): string {
  if (key === SHARED_CORE_SESSION_KEY) {
    return `TRUAPI_SESSION_${siteId}`;
  }
  return `TRUAPI_${siteId}_${key}`;
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
