// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import { dotNsUrl } from "@dotli/shared/dotns-url";

describe("parseDotNsDomain", () => {
  it("parses bare .dot domain", () => {
    expect(dotNsUrl.parseDotNsDomain("mytestapp.dot")).toEqual({
      identifier: "mytestapp.dot",
      pathname: "",
    });
  });

  it("returns null for .dot.li domain (regular website, not a product)", () => {
    expect(dotNsUrl.parseDotNsDomain("mytestapp.dot.li")).toBeNull();
  });

  it("parses .dot domain with https protocol", () => {
    expect(dotNsUrl.parseDotNsDomain("https://mytestapp.dot")).toEqual({
      identifier: "mytestapp.dot",
      pathname: "",
    });
  });

  it("parses .dot domain with http protocol", () => {
    expect(dotNsUrl.parseDotNsDomain("http://mytestapp.dot")).toEqual({
      identifier: "mytestapp.dot",
      pathname: "",
    });
  });

  it("parses .dot domain with pathname", () => {
    expect(dotNsUrl.parseDotNsDomain("mytestapp.dot/some/path")).toEqual({
      identifier: "mytestapp.dot",
      pathname: "some/path",
    });
  });

  it("returns null for .dot.li domain with pathname (regular website)", () => {
    expect(dotNsUrl.parseDotNsDomain("mytestapp.dot.li/some/path")).toBeNull();
  });

  it("parses .dot domain with query only (no path before ?)", () => {
    expect(dotNsUrl.parseDotNsDomain("pr508.faucet.dot?embed=1")).toEqual({
      identifier: "pr508.faucet.dot",
      pathname: "?embed=1",
    });
  });

  it("parses .dot domain with https and query only", () => {
    expect(
      dotNsUrl.parseDotNsDomain("https://pr508.faucet.dot?embed=1"),
    ).toEqual({
      identifier: "pr508.faucet.dot",
      pathname: "?embed=1",
    });
  });

  it("parses .dot domain with hash only", () => {
    expect(dotNsUrl.parseDotNsDomain("pr508.faucet.dot#section=main")).toEqual({
      identifier: "pr508.faucet.dot",
      pathname: "#section=main",
    });
  });

  it("parses .dot domain with pathname, query and hash", () => {
    expect(
      dotNsUrl.parseDotNsDomain(
        "pr508.faucet.dot/nested/path?embed=1#frame=compact",
      ),
    ).toEqual({
      identifier: "pr508.faucet.dot",
      pathname: "nested/path?embed=1#frame=compact",
    });
  });

  it("parses .dot domain from polkadot:// URL host", () => {
    expect(
      dotNsUrl.parseDotNsDomain("polkadot://currenthost.dot/mytestapp.dot"),
    ).toEqual({
      identifier: "currenthost.dot",
      pathname: "mytestapp.dot",
    });
  });

  it("returns null for polkadot:// URL with .dot.li host (not a .dot domain)", () => {
    expect(
      dotNsUrl.parseDotNsDomain("polkadot://currenthost.dot.li/mytestapp.dot"),
    ).toBeNull();
  });

  it("parses .dot domain with path from polkadot:// URL", () => {
    expect(
      dotNsUrl.parseDotNsDomain(
        "polkadot://currenthost.dot/mytestapp.dot/settings",
      ),
    ).toEqual({
      identifier: "currenthost.dot",
      pathname: "mytestapp.dot/settings",
    });
  });

  it("parses .dot domain with query/hash from polkadot:// URL", () => {
    expect(
      dotNsUrl.parseDotNsDomain(
        "polkadot://currenthost.dot/mytestapp.dot?embed=1#frame=compact",
      ),
    ).toEqual({
      identifier: "currenthost.dot",
      pathname: "mytestapp.dot?embed=1#frame=compact",
    });
  });

  it("parses .dot domain from polkadot:// URL with regular path", () => {
    expect(
      dotNsUrl.parseDotNsDomain("polkadot://currenthost.dot/settings"),
    ).toEqual({
      identifier: "currenthost.dot",
      pathname: "settings",
    });
  });

  it("returns null for polkadot:// URL without .dot host", () => {
    expect(
      dotNsUrl.parseDotNsDomain("polkadot://example.com/settings"),
    ).toBeNull();
  });

  it("parses subdomain .dot domain with path", () => {
    expect(dotNsUrl.parseDotNsDomain("sub.acme.dot/path")).toEqual({
      identifier: "sub.acme.dot",
      pathname: "path",
    });
  });

  it("returns null for .dot.li domain with protocol (regular website)", () => {
    expect(
      dotNsUrl.parseDotNsDomain("https://mytestapp.dot.li/path?q=1"),
    ).toBeNull();
  });

  it("trims whitespace before parsing", () => {
    expect(dotNsUrl.parseDotNsDomain("  mytestapp.dot/path  ")).toEqual({
      identifier: "mytestapp.dot",
      pathname: "path",
    });
  });

  it("returns null for localhost URL (not a dot domain)", () => {
    expect(dotNsUrl.parseDotNsDomain("localhost:3000/path")).toBeNull();
  });

  it("returns null for http://localhost URL", () => {
    expect(dotNsUrl.parseDotNsDomain("http://localhost:3000/path")).toBeNull();
  });

  it("returns null for non-.dot domain", () => {
    expect(dotNsUrl.parseDotNsDomain("example.com")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(dotNsUrl.parseDotNsDomain("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(dotNsUrl.parseDotNsDomain("   ")).toBeNull();
  });
});

describe("parseLocalhostUrl", () => {
  it("parses bare localhost with port", () => {
    expect(dotNsUrl.parseLocalhostUrl("localhost:3000")).toEqual({
      host: "localhost:3000",
      pathname: "",
    });
  });

  it("parses localhost with port and path", () => {
    expect(dotNsUrl.parseLocalhostUrl("localhost:3000/some/path")).toEqual({
      host: "localhost:3000",
      pathname: "some/path",
    });
  });

  it("parses http://localhost with port", () => {
    expect(dotNsUrl.parseLocalhostUrl("http://localhost:5000")).toEqual({
      host: "localhost:5000",
      pathname: "",
    });
  });

  it("parses http://localhost with port and path", () => {
    expect(dotNsUrl.parseLocalhostUrl("http://localhost:5000/path")).toEqual({
      host: "localhost:5000",
      pathname: "path",
    });
  });

  it("parses localhost with query and hash", () => {
    expect(dotNsUrl.parseLocalhostUrl("localhost:3000/path?q=1#h")).toEqual({
      host: "localhost:3000",
      pathname: "path?q=1#h",
    });
  });

  it("parses bare localhost without port", () => {
    expect(dotNsUrl.parseLocalhostUrl("localhost")).toEqual({
      host: "localhost",
      pathname: "",
    });
  });

  it("returns null for non-localhost URL", () => {
    expect(dotNsUrl.parseLocalhostUrl("https://example.com")).toBeNull();
  });

  it("parses localhost without port but with path", () => {
    expect(dotNsUrl.parseLocalhostUrl("localhost/path")).toEqual({
      host: "localhost",
      pathname: "path",
    });
  });

  it("parses http://localhost without port but with path", () => {
    expect(dotNsUrl.parseLocalhostUrl("http://localhost/path")).toEqual({
      host: "localhost",
      pathname: "path",
    });
  });

  it("returns null for .dot domain", () => {
    expect(dotNsUrl.parseLocalhostUrl("mytestapp.dot")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(dotNsUrl.parseLocalhostUrl("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(dotNsUrl.parseLocalhostUrl("   ")).toBeNull();
  });
});

describe("isDotDomain", () => {
  it("returns true for .dot domain", () => {
    expect(dotNsUrl.isDotDomain("mytestapp.dot")).toBe(true);
  });

  it("returns false for .dot.li domain (regular website)", () => {
    expect(dotNsUrl.isDotDomain("mytestapp.dot.li")).toBe(false);
  });

  it("returns false for non-.dot domain", () => {
    expect(dotNsUrl.isDotDomain("example.com")).toBe(false);
  });

  it("returns false for localhost", () => {
    expect(dotNsUrl.isDotDomain("localhost")).toBe(false);
  });
});

describe("normalizeUrl", () => {
  it("adds https:// to bare domain", () => {
    expect(dotNsUrl.normalizeUrl("google.com")).toBe("https://google.com/");
  });

  it("adds https:// to bare domain with path", () => {
    expect(dotNsUrl.normalizeUrl("google.com/search?q=test")).toBe(
      "https://google.com/search?q=test",
    );
  });

  it("preserves existing https:// protocol", () => {
    expect(dotNsUrl.normalizeUrl("https://example.com/page")).toBe(
      "https://example.com/page",
    );
  });

  it("preserves existing http:// protocol", () => {
    expect(dotNsUrl.normalizeUrl("http://example.com/page")).toBe(
      "http://example.com/page",
    );
  });

  it("normalizes .dot.li URLs (regular website)", () => {
    expect(dotNsUrl.normalizeUrl("acme.dot.li/path/1")).toBe(
      "https://acme.dot.li/path/1",
    );
  });

  it("returns raw input for unparseable URL", () => {
    expect(dotNsUrl.normalizeUrl(":::invalid")).toBe(":::invalid");
  });

  it("returns raw input for empty string", () => {
    expect(dotNsUrl.normalizeUrl("")).toBe("");
  });
});

describe("isWebcontainerPreviewHost", () => {
  it("matches local-credentialless webcontainer hosts", () => {
    expect(
      dotNsUrl.isWebcontainerPreviewHost(
        "abc--3000--def.local-credentialless.webcontainer-api.io",
      ),
    ).toBe(true);
  });

  it("matches enterprise local-corp webcontainer hosts", () => {
    expect(
      dotNsUrl.isWebcontainerPreviewHost(
        "abc--3000--def.local-corp.webcontainer-api.io",
      ),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(dotNsUrl.isWebcontainerPreviewHost("ABC.WEBCONTAINER-API.IO")).toBe(
      true,
    );
  });

  it("rejects non-webcontainer hosts", () => {
    expect(dotNsUrl.isWebcontainerPreviewHost("mytestapp.dot")).toBe(false);
    expect(dotNsUrl.isWebcontainerPreviewHost("localhost:3000")).toBe(false);
    expect(dotNsUrl.isWebcontainerPreviewHost("evil-webcontainer-api.io")).toBe(
      false,
    );
  });
});
