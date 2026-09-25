// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { parseTri2dStream } from "./tri2d-renderer";

const initial = new Uint8Array([
  69, 84, 68, 49, 1, 0, 24, 0, 64, 0, 0, 0, 48, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0,
  255, 1, 0, 0, 0, 24, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0,
  4, 0, 0, 0, 255, 255, 255, 255, 5, 0, 0, 0, 0, 0, 0, 0,
]);
const destroy = new Uint8Array([
  69, 84, 68, 49, 1, 0, 24, 0, 64, 0, 0, 0, 48, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0,
  255, 3, 0, 0, 0, 4, 0, 0, 0, 1, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0,
]);

describe("Tri2D stream validation", () => {
  it("accepts bounded stateful texture frames", () => {
    const created = parseTri2dStream(initial);
    expect(created).toMatchObject({
      width: 64,
      height: 48,
      drawCount: 0,
      vertexCount: 0,
      indexCount: 0,
      textureBytes: 4,
    });
    expect(created.textures.get(1)).toEqual({ width: 1, height: 1, bytes: 4 });

    const removed = parseTri2dStream(
      destroy,
      created.textures,
      created.textureBytes,
    );
    expect(removed.textures.size).toBe(0);
    expect(removed.textureBytes).toBe(0);
  });

  it("rejects frames without a final presentation boundary", () => {
    const malformed = initial.slice(0, initial.byteLength - 8);
    new DataView(malformed.buffer).setUint32(16, 1, true);
    expect(() => parseTri2dStream(malformed)).toThrow(/presentation boundary/);
  });

  it("rejects state transitions using unknown texture handles", () => {
    expect(() => parseTri2dStream(destroy)).toThrow(/unknown handle/);
  });
});
