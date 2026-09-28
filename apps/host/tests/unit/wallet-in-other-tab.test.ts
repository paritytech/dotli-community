// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { CORE_CUSTODY_BUSY_ERROR } from "@dotli/protocol/core-custody";
import { describeError, ERROR_TITLES } from "../../src/errors";

describe("test wallet open in another tab", () => {
  it("is not reported as an unreachable domain with connectivity advice", () => {
    // Shaped as it arrives over postMessage: only message and name survive.
    const refused = new Error(
      "The test wallet is active in another tab. Close it before opening it here.",
    );
    refused.name = CORE_CUSTODY_BUSY_ERROR;

    for (const isP2p of [true, false]) {
      const described = describeError(refused, isP2p);
      expect(described).toMatchObject({
        kind: "wallet-in-other-tab",
        title: ERROR_TITLES.WALLET_IN_OTHER_TAB,
        recovery: "reload",
        tips: [],
      });
    }
  });
});
