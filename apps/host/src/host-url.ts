// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// URL/label parsing helpers for the host shell. Kept separate from the
// main entry wiring so the parsing logic can be unit-tested in isolation.

import { BASE_DOMAIN, DEBUG } from "@dotli/config/config";
import { isValidDotLabel } from "@dotli/shared/html";

export function parseLocalhostUrl(): string | null {
  if (!DEBUG) {
    return null;
  }
  const path = window.location.pathname;
  const match = /^\/(localhost(?::\d+)?)(.*)$/.exec(path);
  if (match === null) {
    return null;
  }
  const host = match[1];
  const rest = match[2] || "";
  // Strip every reserved host-URL param so they do not leak into the
  // proxied product. Covers the five settings axes, the sandbox contract's
  // host-only signals (`fullReset`, `v`), and the Playwright auth hook.
  const productSearch = new URLSearchParams(window.location.search);
  for (const k of RESERVED_HOST_PARAMS) {
    productSearch.delete(k);
  }
  const query = productSearch.toString();
  return `http://${host}${rest}${query ? `?${query}` : ""}${window.location.hash}`;
}

const RESERVED_HOST_PARAMS = [
  "network",
  "chainBackend",
  "skipArchiveCache",
  "skipCidCache",
  "skipWorkerCache",
  "fullReset",
  "v",
  "initAuthSubscribe",
] as const;

/**
 * Extract the `.dot` label from the current hostname.
 *
 * Returns `"myapp"` for `myapp.dot.li` or `myapp.localhost`. Returns `null`
 * for the bare landing pages (`dot.li`, `localhost`) and for sandbox origins
 * (`*.app.dot.li`, `*.app.localhost`), which are handled by `app-main.ts`.
 *
 * The parsed label is validated against the closed `.dot` label charset as
 * defense-in-depth before it is threaded into key derivation, origin
 * construction (`<label>.app.<root>`), and host-shell sinks. A malformed
 * label can never be a registered `.dot` name, so returning `null` (which
 * routes to the landing/preview path) is the safe outcome.
 */
export function parseDotLabel(): string | null {
  const hostname = window.location.hostname;

  // Production: name.{BASE_DOMAIN} (but NOT *.app.{BASE_DOMAIN})
  if (hostname.endsWith(`.${BASE_DOMAIN}`)) {
    if (hostname.endsWith(`.app.${BASE_DOMAIN}`)) {
      return null;
    }
    const label = hostname.slice(0, -(BASE_DOMAIN.length + 1));
    return isValidDotLabel(label) ? label : null;
  }

  // Local dev: name.localhost (but NOT *.app.localhost)
  if (hostname.endsWith(".localhost")) {
    if (hostname.endsWith(".app.localhost")) {
      return null;
    }
    const label = hostname.slice(0, -".localhost".length);
    return isValidDotLabel(label) ? label : null;
  }

  return null;
}

export function hexToBytes(s: string): Uint8Array {
  const h = s.startsWith("0x") ? s.slice(2) : s;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
