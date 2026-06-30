// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backendLabel,
  formatBlock,
  isTruapiDebugEnabled,
  shortSha,
  summarizeUserAgent,
} from "@dotli/ui/topbar-format";

describe("backendLabel", () => {
  it("maps every backend to a human label", () => {
    expect(backendLabel("smoldot-shared-worker")).toBe("Light Client Shared");
    expect(backendLabel("smoldot-direct")).toBe("Light Client Per-Tab");
    expect(backendLabel("rpc-gateway")).toBe("Trusted Providers");
  });
});

describe("formatBlock", () => {
  it("renders null as n/a", () => {
    expect(formatBlock(null)).toBe("n/a");
  });

  it("renders a number with thousands separators and a hash prefix", () => {
    expect(formatBlock(0)).toBe("#0");
    expect(formatBlock(1234567)).toBe("#1,234,567");
  });
});

describe("shortSha", () => {
  it("passes through the 'dev' sentinel", () => {
    expect(shortSha("dev")).toBe("dev");
  });

  it("leaves short shas untouched", () => {
    expect(shortSha("abc1234")).toBe("abc1234");
  });

  it("truncates long shas to 7 chars", () => {
    expect(shortSha("0123456789abcdef")).toBe("0123456");
  });
});

describe("summarizeUserAgent", () => {
  it("detects Chrome on macOS", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
    expect(summarizeUserAgent(ua)).toBe("Chrome 147 (macOS)");
  });

  it("detects Firefox on Windows", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0";
    expect(summarizeUserAgent(ua)).toBe("Firefox 130 (Windows)");
  });

  it("detects Chrome on Android", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
    expect(summarizeUserAgent(ua)).toBe("Chrome 120 (Android)");
  });

  // iOS UAs contain "like Mac OS X", so the iPhone/iPad check must run
  // before the Mac check to avoid misreporting iPhones as macOS.
  it("detects Safari on iOS despite the 'like Mac OS X' token", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    expect(summarizeUserAgent(ua)).toBe("Safari 17 (iOS)");
  });

  it("prefers Edge over the Chrome token it also carries", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
    expect(summarizeUserAgent(ua)).toBe("Edge 120 (Windows)");
  });

  it("falls back to Unknown for unrecognized agents", () => {
    expect(summarizeUserAgent("some-bot/1.0")).toBe("Unknown (Unknown)");
  });
});

describe("isTruapiDebugEnabled", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("is false when the flag is unset", () => {
    expect(isTruapiDebugEnabled()).toBe(false);
  });

  it("is true only when the flag is exactly '1'", () => {
    sessionStorage.setItem("dotli:truapi-debug", "1");
    expect(isTruapiDebugEnabled()).toBe(true);
    sessionStorage.setItem("dotli:truapi-debug", "true");
    expect(isTruapiDebugEnabled()).toBe(false);
  });

  it("defaults to false when sessionStorage throws", () => {
    vi.stubGlobal("sessionStorage", {
      getItem() {
        throw new Error("unavailable");
      },
    });
    expect(isTruapiDebugEnabled()).toBe(false);
  });
});
