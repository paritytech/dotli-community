// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Pure formatting helpers for the top bar's diagnostics block. Kept free of
// DOM refs and module state so they can be unit-tested in isolation; the
// stateful diagnostics renderer in `topbar.ts` imports them.

import type { Backend } from "@dotli/config/mode";

export function isTruapiDebugEnabled(): boolean {
  try {
    return sessionStorage.getItem("dotli:truapi-debug") === "1";
  } catch {
    // sessionStorage may be unavailable in exotic environments (Safari
    // private mode). Default to "not in debug mode".
    return false;
  }
}

export function backendLabel(b: Backend): string {
  switch (b) {
    case "smoldot-shared-worker":
      return "Light Client Shared";
    case "smoldot-direct":
      return "Light Client Per-Tab";
    case "rpc-gateway":
      return "Trusted Providers";
  }
}

export function formatBlock(n: number | null): string {
  return n === null ? "n/a" : `#${n.toLocaleString("en-US")}`;
}

export function shortSha(sha: string): string {
  if (sha === "dev" || sha.length <= 7) {
    return sha;
  }
  return sha.slice(0, 7);
}

/**
 * Turn a long `navigator.userAgent` string into something compact like
 * "Chrome 147 (macOS)". Heuristic, not a replacement for a real UA parser.
 * Good enough for a debug row that the user can still click-to-copy the
 * full value (the row shows the short version but the UA is stable enough
 * that engineers can recognize the brand without the full payload).
 */
export function summarizeUserAgent(ua: string): string {
  let browser = "Unknown";
  const chromeMatch = /(Chrome|CriOS)\/(\d+)/.exec(ua);
  const firefoxMatch = /Firefox\/(\d+)/.exec(ua);
  const safariMatch = /Version\/(\d+)[^)]+Safari/.exec(ua);
  const edgeMatch = /Edg\/(\d+)/.exec(ua);
  if (edgeMatch) {
    browser = `Edge ${edgeMatch[1]}`;
  } else if (firefoxMatch) {
    browser = `Firefox ${firefoxMatch[1]}`;
  } else if (chromeMatch) {
    browser = `Chrome ${chromeMatch[2]}`;
  } else if (safariMatch) {
    browser = `Safari ${safariMatch[1]}`;
  }

  let os = "Unknown";
  // iPhone/iPad first: iOS UAs contain "like Mac OS X", so the Mac check
  // would otherwise claim them.
  if (ua.includes("iPhone") || ua.includes("iPad")) {
    os = "iOS";
  } else if (ua.includes("Mac OS X") || ua.includes("Macintosh")) {
    os = "macOS";
  } else if (ua.includes("Windows")) {
    os = "Windows";
  } else if (ua.includes("Android")) {
    os = "Android";
  } else if (ua.includes("Linux")) {
    os = "Linux";
  }

  return `${browser} (${os})`;
}
