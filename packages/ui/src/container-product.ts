// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Pure helpers for the host container bridge: deriving product identifiers
// and labels, building product URLs, and value checks. No DOM refs and no
// bridge state, so they can be unit-tested in isolation; `container.ts`
// imports them.

import { isLocalhost, BASE_DOMAIN } from "@dotli/config/config";
import { normalizeProductAccountId } from "@dotli/auth/account";
import { dotNsUrl } from "@dotli/shared/dotns-url";

// localhost proxy and webcontainer previews are developer affordances for
// running a `.dot` app before it's deployed.
export function isDevPreviewLabel(label: string): boolean {
  return (
    label.startsWith("localhost:") || dotNsUrl.isWebcontainerPreviewHost(label)
  );
}

/**
 * Derive the product-id from an iframe label.
 *
 * Dev previews (localhost proxy, webcontainer) keep the bare host label. dotNs
 * products get the `.dot` suffix appended. Same rule encoded in
 * `isProductAccountValid`.
 */
export function labelToProductIdentifier(label: string): string {
  return isDevPreviewLabel(label) ? label : `${label}.dot`;
}

export function labelAcceptsIdentifier(label: string, id: string): boolean {
  return (
    dotNsUrl.isProductIdentifier(id) || id === labelToProductIdentifier(label)
  );
}

// Dev previews are permissive. A deployed `.dot` must sign as its own identifier.
export function isProductAccountValid(
  label: string,
  accountId: string,
): boolean {
  if (isDevPreviewLabel(label)) {
    return labelAcceptsIdentifier(label, accountId);
  }
  return accountId === labelToProductIdentifier(label);
}

/**
 * Resolve the product-account tuple a product is allowed to act as.
 */
export function resolveProductAccountId(
  label: string,
  reported: Parameters<typeof normalizeProductAccountId>[0],
): ReturnType<typeof normalizeProductAccountId> {
  const normalized = normalizeProductAccountId(reported);
  return isDevPreviewLabel(label)
    ? normalized
    : [labelToProductIdentifier(label), normalized[1]];
}

export function identifierToLabel(identifier: string): string {
  return identifier.slice(0, -".dot".length);
}

/** Build a full URL for a .dot product on the current environment. */
export function buildDotTargetUrl(label: string, pathname: string): string {
  const suffix = pathname ? "/" + pathname : "";
  if (isLocalhost) {
    return `http://${label}.localhost:${window.location.port}${suffix}`;
  }
  return `${window.location.protocol}//${label}.${BASE_DOMAIN}${suffix}`;
}

/** Bare host origin without any product subdomain (e.g. `http://localhost:5173` or `https://dot.li`). */
export function getHostOrigin(): string {
  if (isLocalhost) {
    return `http://localhost:${window.location.port}`;
  }
  return `${window.location.protocol}//${BASE_DOMAIN}`;
}

/** Check if a value is a Uint8Array (or cross-realm equivalent). */
export function isUint8ArrayLike(data: unknown): data is Uint8Array {
  if (data instanceof Uint8Array) {
    return true;
  }
  if (typeof data !== "object" || data === null) {
    return false;
  }
  return (
    (data as { constructor: { name: string } }).constructor.name ===
    "Uint8Array"
  );
}
