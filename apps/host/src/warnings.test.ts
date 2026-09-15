// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { describeStall } from "./warnings";

describe("describeStall throughput", () => {
  it("As a user on a slow connection, I see the real rate rather than zero", () => {
    expect(
      describeStall({ chain: "relay", peers: 2, bytesPerSecond: 300 }),
    ).toBe("Fetching Polkadot from 2 computers at 300 B/s. Slower than usual.");
  });

  it("As a user with nothing arriving, I am told that instead of shown a zero rate", () => {
    expect(
      describeStall({ chain: "relay", peers: 2, bytesPerSecond: 0.4 }),
    ).toBe(
      "Connected to 2 computers for Polkadot, but no data is arriving yet.",
    );
  });

  it("As a user on an ordinary connection, I see the rate in kilobytes", () => {
    expect(
      describeStall({ chain: "relay", peers: 2, bytesPerSecond: 2048 }),
    ).toBe("Fetching Polkadot from 2 computers at 2 kB/s. Slower than usual.");
  });

  it("As a user on a fast connection, I see the rate in megabytes", () => {
    expect(
      describeStall({ chain: "bulletin", peers: 1, bytesPerSecond: 2_097_152 }),
    ).toBe(
      "Fetching the app files from 1 computer at 2.0 MB/s. Slower than usual.",
    );
  });
});
