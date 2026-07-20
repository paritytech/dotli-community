// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { SITE_ID } from "@dotli/config/config";
import {
  buildLegacySharedAuthSessionStorageKey,
  buildSharedAuthStorageKey,
  isSharedAuthOriginAllowed,
  isSharedAuthRequestMethod,
  isSharedAuthSiteId,
  isValidSharedAuthKey,
  SHARED_CORE_SESSION_KEY,
} from "@dotli/protocol/auth-storage";

describe("shared auth storage helpers", () => {
  it("accepts host shell origins and rejects app origins", () => {
    expect(isSharedAuthOriginAllowed("https://dot.li")).toBe(true);
    expect(isSharedAuthOriginAllowed("https://browse.dot.li")).toBe(true);
    expect(isSharedAuthOriginAllowed("https://host-playground.dot.li")).toBe(
      true,
    );
    expect(isSharedAuthOriginAllowed("https://host.dot.li")).toBe(true);

    expect(isSharedAuthOriginAllowed("https://bafy.app.dot.li")).toBe(false);
    expect(isSharedAuthOriginAllowed("https://app.dot.li")).toBe(false);
    expect(isSharedAuthOriginAllowed("https://evil.example.com")).toBe(false);
  });

  it("accepts localhost host shells and rejects localhost app origins", () => {
    expect(isSharedAuthOriginAllowed("http://localhost:5173")).toBe(true);
    expect(isSharedAuthOriginAllowed("http://browse.localhost:5173")).toBe(
      true,
    );
    expect(isSharedAuthOriginAllowed("http://host.localhost:5173")).toBe(true);

    expect(isSharedAuthOriginAllowed("http://bafy.app.localhost:5173")).toBe(
      false,
    );
  });

  it("accepts only the current shell's SITE_ID", () => {
    // In the vitest happy-dom environment, `self.location.hostname` is
    // "localhost", so `SITE_ID` is "local.li". The allowlist is runtime-
    // driven, not a hard-coded list. This guarantees a host running on
    // `host.paseoli.dev` would accept `"paseoli.dev"` and reject `"dot.li"`,
    // and vice versa.
    expect(SITE_ID).toBe("local.li");
    expect(isSharedAuthSiteId(SITE_ID)).toBe(true);
  });

  it("rejects siteIds belonging to unrelated root domains", () => {
    // A hard-coded allowlist would treat these as `true`. They must all be
    // `false` because cross-root-domain session sharing is explicitly
    // disallowed across dot.li, paseo.li, and paseoli.dev.
    expect(isSharedAuthSiteId("dot.li")).toBe(false);
    expect(isSharedAuthSiteId("paseo.li")).toBe(false);
    expect(isSharedAuthSiteId("paseoli.dev")).toBe(false);
    expect(isSharedAuthSiteId("staging.dot.li")).toBe(false);
    expect(isSharedAuthSiteId("")).toBe(false);
  });

  it("validates storage keys", () => {
    expect(isValidSharedAuthKey("SsoSessions")).toBe(true);
    expect(isValidSharedAuthKey("UserSecrets_abc-123")).toBe(true);
    expect(isValidSharedAuthKey("identity_0x1234")).toBe(true);
    expect(isValidSharedAuthKey("../secrets")).toBe(false);
    expect(isValidSharedAuthKey("key with spaces")).toBe(false);
    expect(isValidSharedAuthKey("")).toBe(false);
  });

  it("builds stable storage keys", () => {
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
  });

  it("identifies shared-auth RPC methods", () => {
    expect(isSharedAuthRequestMethod("authStorageRead")).toBe(true);
    expect(isSharedAuthRequestMethod("authStorageWrite")).toBe(true);
    expect(isSharedAuthRequestMethod("authStorageClear")).toBe(true);
    expect(isSharedAuthRequestMethod("warmup")).toBe(false);
  });
});
