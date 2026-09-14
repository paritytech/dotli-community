// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { describeStall } from "../../src/warnings";

describe("describeStall throughput", () => {
  it("reads a trickle in bytes rather than rounding it to zero", () => {
    expect(
      describeStall({ chain: "relay", peers: 2, bytesPerSecond: 300 }),
    ).toBe("Fetching Polkadot from 2 computers at 300 B/s. Slower than usual.");
  });

  it("says nothing is arriving rather than printing a zero rate", () => {
    expect(
      describeStall({ chain: "relay", peers: 2, bytesPerSecond: 0.4 }),
    ).toBe(
      "Connected to 2 computers for Polkadot, but no data is arriving yet.",
    );
  });

  it("keeps kilobytes for rates a kilobyte and over", () => {
    expect(
      describeStall({ chain: "relay", peers: 2, bytesPerSecond: 2048 }),
    ).toBe("Fetching Polkadot from 2 computers at 2 kB/s. Slower than usual.");
  });

  it("keeps megabytes for the fastest rates", () => {
    expect(
      describeStall({ chain: "bulletin", peers: 1, bytesPerSecond: 2_097_152 }),
    ).toBe(
      "Fetching the app files from 1 computer at 2.0 MB/s. Slower than usual.",
    );
  });
});
