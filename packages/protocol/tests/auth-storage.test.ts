// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { SITE_ID } from "@dotli/config/config";
import {
  buildLegacySharedAuthSessionStorageKey,
  buildSharedAuthStorageKey,
  buildSharedModeStorageKey,
  isSharedAuthOriginAllowed,
  isSharedAuthRequestMethod,
  isSharedAuthSiteId,
  isSharedModeRequestMethod,
  isValidSharedAuthKey,
  isValidSharedModeKey,
  SHARED_CORE_SESSION_KEY,
} from "@dotli/protocol/auth-storage";

describe("shared auth and mode storage helpers", () => {
  interface OriginCase {
    origin: string;
    allowed: boolean;
    reason: string;
  }

  const originCases: OriginCase[] = [
    { origin: "https://dot.li", allowed: true, reason: "root host shell" },
    { origin: "https://browse.dot.li", allowed: true, reason: "browse subdomain" },
    { origin: "https://host-playground.dot.li", allowed: true, reason: "playground subdomain" },
    { origin: "https://host.dot.li", allowed: true, reason: "host subdomain" },
    { origin: "https://bafy.app.dot.li", allowed: false, reason: "app subdomain" },
    { origin: "https://app.dot.li", allowed: false, reason: "app root" },
    { origin: "https://evil.example.com", allowed: false, reason: "foreign domain" },
    { origin: "http://localhost:5173", allowed: true, reason: "localhost port" },
    { origin: "http://browse.localhost:5173", allowed: true, reason: "browse localhost" },
    { origin: "http://host.localhost:5173", allowed: true, reason: "host localhost" },
    { origin: "http://bafy.app.localhost:5173", allowed: false, reason: "app localhost" },
    { origin: "http://dot.li", allowed: false, reason: "insecure http remote" },
    { origin: "not a url", allowed: false, reason: "malformed url string" },
  ];

  it.each(originCases)(
    "evaluates origin $origin as $allowed because it is $reason",
    ({ origin, allowed }) => {
      expect(isSharedAuthOriginAllowed(origin)).toBe(allowed);
    },
  );

  it("accepts only the current shell's SITE_ID", () => {
    expect(SITE_ID).toBe("local.li");
    expect(isSharedAuthSiteId(SITE_ID)).toBe(true);
  });

  it.each(["dot.li", "paseo.li", "paseoli.dev", "staging.dot.li", ""])(
    "rejects foreign or empty siteId %s",
    (siteId) => {
      expect(isSharedAuthSiteId(siteId)).toBe(false);
    },
  );

  it.each([
    { key: "SsoSessions", valid: true },
    { key: "UserSecrets_abc-123", valid: true },
    { key: "identity_0x1234", valid: true },
    { key: "../secrets", valid: false },
    { key: "key with spaces", valid: false },
    { key: "", valid: false },
  ])("validates auth key $key as $valid", ({ key, valid }) => {
    expect(isValidSharedAuthKey(key)).toBe(valid);
  });

  it.each([
    { key: "backend", valid: true },
    { key: "dotli:chain-backend", valid: true },
    { key: "cache_policy-v2", valid: true },
    { key: "invalid key!", valid: false },
    { key: "", valid: false },
  ])("validates mode key $key as $valid", ({ key, valid }) => {
    expect(isValidSharedModeKey(key)).toBe(valid);
  });

  it("builds consistent shared storage keys for auth and mode namespaces", () => {
    expect(buildSharedAuthStorageKey("dot.li", SHARED_CORE_SESSION_KEY)).toBe(
      "TRUAPI_dot.li_session",
    );
    expect(
      buildSharedAuthStorageKey("paseoli.dev", SHARED_CORE_SESSION_KEY),
    ).toBe("TRUAPI_paseoli.dev_session");
    expect(buildSharedAuthStorageKey("dot.li", "UserSecrets")).toBe(
      "TRUAPI_dot.li_UserSecrets",
    );
    expect(buildLegacySharedAuthSessionStorageKey("dot.li")).toBe(
      "PAPP_dot.li_SsoSessionsV3",
    );
    expect(buildSharedModeStorageKey("local.li", "backend")).toBe(
      "DOTLI_MODE_local.li_backend",
    );
  });

  it("identifies shared-auth and shared-mode RPC methods", () => {
    expect(isSharedAuthRequestMethod("authStorageRead")).toBe(true);
    expect(isSharedAuthRequestMethod("authStorageWrite")).toBe(true);
    expect(isSharedAuthRequestMethod("authStorageClear")).toBe(true);
    expect(isSharedAuthRequestMethod("warmup")).toBe(false);

    expect(isSharedModeRequestMethod("modeStorageRead")).toBe(true);
    expect(isSharedModeRequestMethod("modeStorageWrite")).toBe(true);
    expect(isSharedModeRequestMethod("modeStorageClear")).toBe(true);
    expect(isSharedModeRequestMethod("resolveDotName")).toBe(false);
  });
});
