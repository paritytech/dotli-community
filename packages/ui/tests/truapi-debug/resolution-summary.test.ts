// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { buildResolution } from "@dotli/truapi-debug/resolution-view";
import type { DotliDebugEvent } from "@dotli/truapi-debug/dotli-debug-types";

function load(hits: number, misses: number): DotliDebugEvent[] {
  return [
    {
      layer: "boot",
      event: "started",
      flowId: "boot-1",
      timestamp: 0,
      payload: {
        chainBackend: "smoldot-direct",
        skipCidCache: false,
        skipArchiveCache: false,
      },
    },
    {
      layer: "boot",
      event: "block_cache",
      flowId: "boot-1",
      timestamp: 50,
      payload: { hits, misses },
    },
  ];
}

describe("resolution summary: archive cache", () => {
  it("As a developer, a load served entirely from the host's block cache reads as an archive cache hit", () => {
    // When
    const model = buildResolution(load(12, 0), 100);

    // Then
    expect(model.summary.archiveCache).toBe("hit");
  });

  it("As a developer, a load that fetched any block over the network reads as a miss", () => {
    // When
    const model = buildResolution(load(3, 2), 100);

    // Then
    expect(model.summary.archiveCache).toBe("miss");
  });
});
