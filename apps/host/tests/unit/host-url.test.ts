// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import {
  hexToBytes,
  parseDotLabel,
  parseLocalhostUrl,
} from "../../src/host-url.ts";

// host-url reads window.location live, so each test stubs it. BASE_DOMAIN is
// derived once at config import time from happy-dom's default localhost
// origin, so it stays "dot.li" regardless of these per-test stubs.
const realLocation = window.location;

function setLocation(parts: {
  hostname?: string;
  pathname?: string;
  search?: string;
  hash?: string;
}): void {
  Object.defineProperty(window, "location", {
    value: {
      hostname: "localhost",
      pathname: "/",
      search: "",
      hash: "",
      ...parts,
    },
    writable: true,
    configurable: true,
  });
}

afterEach(() => {
  Object.defineProperty(window, "location", {
    value: realLocation,
    writable: true,
    configurable: true,
  });
});

describe("hexToBytes", () => {
  it("decodes a 0x-prefixed hex string", () => {
    expect(Array.from(hexToBytes("0x010203"))).toEqual([1, 2, 3]);
  });

  it("decodes a bare hex string", () => {
    expect(Array.from(hexToBytes("ff00ab"))).toEqual([255, 0, 171]);
  });

  it("returns an empty array for an empty input", () => {
    expect(Array.from(hexToBytes("0x"))).toEqual([]);
    expect(Array.from(hexToBytes(""))).toEqual([]);
  });
});

describe("parseDotLabel", () => {
  it("extracts the label from a production .dot.li host", () => {
    setLocation({ hostname: "myapp.dot.li" });
    expect(parseDotLabel()).toBe("myapp");
  });

  it("extracts the label from a .localhost host", () => {
    setLocation({ hostname: "myapp.localhost" });
    expect(parseDotLabel()).toBe("myapp");
  });

  it("returns null for sandbox app subdomains", () => {
    setLocation({ hostname: "myapp.app.dot.li" });
    expect(parseDotLabel()).toBeNull();
    setLocation({ hostname: "myapp.app.localhost" });
    expect(parseDotLabel()).toBeNull();
  });

  it("returns null for the bare landing pages", () => {
    setLocation({ hostname: "dot.li" });
    expect(parseDotLabel()).toBeNull();
    setLocation({ hostname: "localhost" });
    expect(parseDotLabel()).toBeNull();
  });

  it("returns null for a structurally invalid label (uppercase)", () => {
    setLocation({ hostname: "MyApp.dot.li" });
    expect(parseDotLabel()).toBeNull();
  });
});

describe("parseLocalhostUrl", () => {
  it("rebuilds the proxied URL and strips reserved host params", () => {
    setLocation({
      pathname: "/localhost:5173/app",
      search: "?network=foo&keep=1",
      hash: "#section",
    });
    expect(parseLocalhostUrl()).toBe(
      "http://localhost:5173/app?keep=1#section",
    );
  });

  it("returns null when the path is not a localhost proxy path", () => {
    setLocation({ pathname: "/some/other/path" });
    expect(parseLocalhostUrl()).toBeNull();
  });
});
