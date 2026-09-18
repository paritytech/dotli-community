// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The prompt-content contract for the reviews where wording is
// safety-relevant: whether an approval is final at the terminal or verified
// again on the phone must match where signing actually happens.

import { describe, it, expect } from "vitest";
import { describeReview } from "../src/reviews.js";

describe("describeReview", () => {
  it("As a CLI user, a Bulletin publish prompt tells me approval is final and never promises a phone checkpoint", () => {
    // Given
    // Bulletin writes sign in-core with the allowance key. Measured with the
    // phone off: phone-dependent operations time out, Bulletin writes
    // succeed. The prompt must not claim otherwise.
    const request = describeReview({
      tag: "PreimageSubmit",
      value: { size: 614400n },
    });

    // Then
    expect(request.phoneVerifies).toBe(false);
    expect(request.phoneNote).toMatch(/final/i);
    expect(request.phoneNote).not.toMatch(/phone/i);
    expect(request.details.join(" ")).toContain("614400 bytes");
  });

  it("As a CLI user, a raw-message signing prompt still defers to the phone", () => {
    // Given
    const request = describeReview({
      tag: "SignRaw",
      value: {
        tag: "Product",
        value: {
          account: {
            dotNsIdentifier: "test.dot",
            derivationIndex: { tag: "Index", value: 0 },
          },
          payload: { tag: "Bytes", value: { bytes: "0xdeadbeef" } },
        },
      },
    });

    // Then
    expect(request.phoneVerifies).toBe(true);
    expect(request.phoneNote).toBeUndefined();
    expect(request.details.join(" ")).toContain("raw binary data (4 bytes)");
  });
});
