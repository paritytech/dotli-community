// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  POLKAVM_RUNTIME_VERSION,
  polkaVmRuntimeAssetUrl,
} from "./polkavm-runtime-assets";

describe("polkaVmRuntimeAssetUrl", () => {
  it("keys stable public runtime filenames by the current build", () => {
    const url = new URL(
      polkaVmRuntimeAssetUrl("polkavm-browser-runtime.wasm"),
      "https://example.test",
    );

    expect(url.pathname).toBe("/polkavm-runtime/polkavm-browser-runtime.wasm");
    expect(url.searchParams.get("v")).toBe(POLKAVM_RUNTIME_VERSION);
    expect(POLKAVM_RUNTIME_VERSION).not.toBe("");
  });
});
