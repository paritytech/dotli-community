// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  assertNoHostOwnedPaths,
  shadowsHostOwnedPath,
} from "./host-owned-paths";

describe("host-owned archive paths", () => {
  it("reserves raw and encoded aliases of the runtime tree", () => {
    expect(shadowsHostOwnedPath("polkavm-runtime/polkavm-worker.js")).toBe(
      true,
    );
    expect(shadowsHostOwnedPath("/polkavm-runtime/polkavm-worker.js")).toBe(
      true,
    );
    expect(shadowsHostOwnedPath("polkavm-runtime%2Fpolkavm-worker.js")).toBe(
      true,
    );
    expect(shadowsHostOwnedPath("%70olkavm-runtime/polkavm-worker.js")).toBe(
      true,
    );
    expect(shadowsHostOwnedPath("assets/polkavm-worker.js")).toBe(false);
    expect(() => {
      assertNoHostOwnedPaths([
        "index.html",
        "polkavm-runtime/polkavm-worker.js",
      ]);
    }).toThrow("archive path is reserved by the host");
  });
});
