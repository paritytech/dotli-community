// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dotNS URL parsing utilities.
//
// Parses .dot domain URLs in various formats (bare, with protocol, polkadot://)
// and identifies products by the canonical `.dot` TLD.
// URLs with other TLDs (dot.li, paseo.li, google.com, etc.) are regular websites.
//
// Parse outcomes are discriminated unions. A `null` return would hide
// whether the input was empty, unparseable, the wrong TLD, a localhost
// attempt, etc. Callers that only need a pass/fail signal can use the
// legacy wrappers (`parseDotNsDomain`, `parseLocalhostUrl`, `normalizeUrl`)
// which collapse the result. Callers that need the reason should use the
// `*Result` helpers.
//
// This module intentionally does not import `@dotli/metrics` to avoid a
// dependency cycle (`metrics` depends on `shared` which would depend on
// `metrics`). Observability for parse failures is the caller's
// responsibility. The caller has enough context (which input, which user
// action) to tag the metric meaningfully.

export interface DotNsUrl {
  identifier: string; // e.g. "mytestapp.dot" (always ends with .dot)
  pathname: string; // e.g. "some/path?q=1#h=2" (no leading slash)
}

export type DotNsUrlResult =
  | { kind: "ok"; url: DotNsUrl }
  | { kind: "empty" }
  | { kind: "parse-error"; reason: string }
  | { kind: "not-dot-domain"; hostname: string }
  | { kind: "port-or-userinfo"; hostname: string };

/**
 * `.dot` TLD check, NFC-normalized and case-folded.
 *
 * The `.dot` authority is defined over lowercase ASCII. A hostname
 * arriving via `new URL(...)` might be pre-punycoded or mixed-case.
 * Normalizing here means both `Example.DOT` and `example.dot` hit the
 * same outcome, while genuine IDN labels outside the ASCII range still
 * round-trip through their punycode form.
 */
function isDotDomain(domain: string): boolean {
  return domain.normalize("NFC").toLowerCase().endsWith(".dot");
}

function isProductIdentifier(id: string): boolean {
  const n = id.normalize("NFC").toLowerCase();
  return n.endsWith(".dot") || n === "localhost" || n.startsWith("localhost:");
}

function isWebcontainerPreviewHost(host: string): boolean {
  return host.toLowerCase().endsWith(".webcontainer-api.io");
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Parse a URL, optionally assuming `https://` when no protocol is present.
 *
 * Callers must opt in explicitly via `assumeHttps`. Prepending `https://`
 * on any parse failure would be a hidden fallback, so when the prefix is
 * applied the call site is responsible for documenting the reason (e.g.
 * the user typed a bare hostname).
 */
function parseUrlWithExplicitHttps(
  url: string,
  options: { assumeHttps: boolean },
): URL | null {
  const direct = parseUrl(url);
  if (direct !== null) {
    return direct;
  }
  if (!options.assumeHttps) {
    return null;
  }
  return parseUrl("https://" + url);
}

/**
 * Parse a `.dot` domain URL. Returns a discriminated result so callers
 * can distinguish empty input from the wrong TLD from a parse failure.
 * Each warrants a different UI hint.
 *
 * Host validation rejects URLs that carry an explicit port or userinfo
 * component. `.dot` identifiers are resolved via the chain and IPFS path
 * and have no concept of either. Silently dropping them would let a user
 * paste `user:pass@x.dot:8080/path` and land on `x.dot/path` without being
 * told the credentials and port were discarded.
 */
export function parseDotNsDomainResult(url: string): DotNsUrlResult {
  const normalized = url.trim();
  if (normalized.length === 0) {
    return { kind: "empty" };
  }

  const parsed = normalized.startsWith("polkadot://")
    ? parseUrl(normalized)
    : parseUrlWithExplicitHttps(normalized, { assumeHttps: true });

  if (parsed === null) {
    return { kind: "parse-error", reason: "URL constructor rejected input" };
  }

  if (parsed.port !== "" || parsed.username !== "" || parsed.password !== "") {
    return { kind: "port-or-userinfo", hostname: parsed.hostname };
  }

  if (!isDotDomain(parsed.hostname)) {
    return { kind: "not-dot-domain", hostname: parsed.hostname };
  }

  return {
    kind: "ok",
    url: {
      identifier: parsed.hostname.normalize("NFC").toLowerCase(),
      pathname:
        parsed.pathname.replace(/^\//, "") + parsed.search + parsed.hash,
    },
  };
}

/** Legacy pass/fail wrapper. Prefer `parseDotNsDomainResult`. */
function parseDotNsDomain(url: string): DotNsUrl | null {
  const result = parseDotNsDomainResult(url);
  return result.kind === "ok" ? result.url : null;
}

export interface LocalhostUrl {
  host: string; // e.g. "localhost:5000"
  pathname: string; // e.g. "path?q=1#h=2" (no leading slash)
}

export type LocalhostUrlResult =
  | { kind: "ok"; url: LocalhostUrl }
  | { kind: "empty" }
  | { kind: "parse-error" }
  | { kind: "not-localhost"; hostname: string };

export function parseLocalhostUrlResult(url: string): LocalhostUrlResult {
  const normalized = url.trim();
  if (normalized.length === 0) {
    return { kind: "empty" };
  }

  const withProtocol = normalized.startsWith("localhost")
    ? "http://" + normalized
    : normalized;

  const parsed = parseUrl(withProtocol);
  if (parsed === null) {
    return { kind: "parse-error" };
  }
  if (parsed.hostname !== "localhost") {
    return { kind: "not-localhost", hostname: parsed.hostname };
  }

  return {
    kind: "ok",
    url: {
      host: parsed.host,
      pathname:
        parsed.pathname.replace(/^\//, "") + parsed.search + parsed.hash,
    },
  };
}

/** Legacy pass/fail wrapper. Prefer `parseLocalhostUrlResult`. */
function parseLocalhostUrl(url: string): LocalhostUrl | null {
  const result = parseLocalhostUrlResult(url);
  return result.kind === "ok" ? result.url : null;
}

export type NormalizeUrlResult =
  | { kind: "ok"; url: string }
  | { kind: "empty" }
  | { kind: "parse-error"; raw: string };

/**
 * Ensure a URL has a protocol so it opens as absolute, not relative.
 *
 * Returns a discriminated result so callers know whether the input was
 * returned unchanged (parse failure) or normalized.
 */
export function normalizeUrlResult(url: string): NormalizeUrlResult {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return { kind: "empty" };
  }
  const parsed = parseUrlWithExplicitHttps(trimmed, { assumeHttps: true });
  if (parsed === null) {
    return { kind: "parse-error", raw: url };
  }
  return { kind: "ok", url: parsed.href };
}

/**
 * Legacy wrapper that collapses the discriminated outcome to a string.
 *
 * Returns the raw input on parse failure so existing call sites keep
 * working. Prefer `normalizeUrlResult` for new code.
 */
function normalizeUrl(url: string): string {
  const result = normalizeUrlResult(url);
  switch (result.kind) {
    case "ok":
      return result.url;
    case "empty":
      return url;
    case "parse-error":
      return result.raw;
  }
}

export const dotNsUrl = {
  isDotDomain,
  isProductIdentifier,
  isWebcontainerPreviewHost,
  parseDotNsDomain,
  parseLocalhostUrl,
  normalizeUrl,
};
