// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { UR, UREncoder } from "@ngraveio/bc-ur";
import { Buffer } from "buffer";
import { CameraUrDecoder } from "../src/mediated-input-camera";

describe("CameraUrDecoder", () => {
  it("reconstructs a typed multi-frame UR into its bounded CBOR bytes", () => {
    const bytes = new Uint8Array(256).map((_, index) => index);
    const encoder = new UREncoder(
      new UR(Buffer.from(bytes), "x-test-payload"),
      30,
    );
    const decoder = new CameraUrDecoder({
      mediaType: "x-test-payload",
      maxBytes: bytes.byteLength,
    });

    let completed: Uint8Array | null = null;
    const limit = encoder.fragmentsLength * 4 + 32;
    for (let index = 0; index < limit && completed === null; index += 1) {
      completed = decoder.receive(encoder.nextPart()).bytes;
    }

    expect(completed).toEqual(bytes);
  });

  it("rejects a reconstructed value larger than the registration bound", () => {
    const encoder = new UREncoder(
      new UR(Buffer.from([1, 2, 3, 4]), "x-test-payload"),
      30,
    );
    const decoder = new CameraUrDecoder({
      mediaType: "x-test-payload",
      maxBytes: 3,
    });

    expect(() => decoder.receive(encoder.nextPart())).toThrow(
      "exceeds the registered input bound",
    );
  });
});
