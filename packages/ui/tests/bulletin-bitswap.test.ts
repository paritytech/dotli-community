// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import { onContentProgress, __testing } from "@dotli/ui/bulletin-bitswap";

describe("Content progress reporting works", () => {
  it("As a user, my download progress reaches the loading bar and the trace alike", () => {
    // Given the resolution trace and the loading bar both subscribe, and a
    // single callback slot would hand the stream to whichever came last.
    const first: number[] = [];
    const second: number[] = [];
    onContentProgress(({ bytesFetched }) => first.push(bytesFetched));
    const unsubscribe = onContentProgress(({ bytesFetched }) =>
      second.push(bytesFetched),
    );

    // When
    __testing.noteBlock(new Uint8Array(100));

    // Then
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);

    // When one unsubscribes, the other keeps receiving.
    unsubscribe();
    __testing.noteBlock(new Uint8Array(50));
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
  });
});
