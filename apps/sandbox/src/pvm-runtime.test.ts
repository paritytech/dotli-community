// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { describePvmPackage, isPvmPackage } from "./pvm-runtime";

const encoder = new TextEncoder();

function doomManifest(): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      $schema: "epoca:experimental-product/v1",
      $v: 1,
      kind: "framebuffer",
      runtime: { kind: "polkavm", entrypoint: "app.polkavm" },
      modalities: {
        framebuffer: {
          abiVersion: 1,
          controls: ["WASD Move", "Space Fire"],
        },
      },
      contentSlots: [
        {
          id: "iwad",
          required: true,
          mount: "game/doom.wad",
        },
      ],
    }),
  );
}

function doomAppV2Manifest(): string {
  return JSON.stringify({
    $v: 2,
    kind: "app",
    appVersion: [0, 1, 7],
    runtime: {
      kind: "polkavm",
      abiVersion: 1,
      entrypoint: "app.polkavm",
    },
    capabilities: {
      graphics: {
        abiVersion: 1,
        profile: "framebuffer",
        requiredFeatures: [],
      },
      deviceInput: {
        abiVersion: 1,
        requiredFeatures: ["pointer", "keyboard"],
      },
      audio: { abiVersion: 1, requiredFeatures: [] },
    },
  });
}

describe("PolkaVM package recognition", () => {
  it("recognizes the deployed doom.paseo package shape", () => {
    const files = {
      "manifest.json": doomManifest(),
      "app.polkavm": new Uint8Array([1, 2, 3]),
      "game/doom.wad": new Uint8Array([4, 5, 6]),
    };

    expect(isPvmPackage(files)).toBe(true);
    expect(describePvmPackage(files)).toEqual({
      programPath: "app.polkavm",
      controls: ["WASD Move", "Space Fire"],
      audioEnabled: true,
      requiredAssets: ["game/doom.wad"],
      manifestVersion: null,
    });
  });

  it("recognizes App manifest v2 and requires exact external bytes", () => {
    const manifest = doomAppV2Manifest();
    const files = {
      "manifest.json": encoder.encode(manifest),
      "app.polkavm": new Uint8Array([1, 2, 3]),
      "game/doom.wad": new Uint8Array([4, 5, 6]),
    };

    expect(describePvmPackage(files, manifest)).toEqual({
      programPath: "app.polkavm",
      controls: ["Pointer", "Keyboard"],
      audioEnabled: true,
      requiredAssets: [],
      manifestVersion: 2,
    });
    expect(() => describePvmPackage(files)).toThrow(
      /external App manifest is required/,
    );
    expect(() => describePvmPackage(files, `${manifest}\n`)).toThrow(
      /does not match/,
    );
  });

  it("leaves ordinary HTML archives on the existing sandbox path", () => {
    expect(
      isPvmPackage({
        "index.html": encoder.encode("<h1>app</h1>"),
      }),
    ).toBe(false);
  });

  it("rejects unsupported graphics profiles rather than guessing", () => {
    const manifest = encoder.encode(
      JSON.stringify({
        $schema: "epoca:experimental-product/v2",
        $v: 2,
        kind: "application",
        runtime: { kind: "polkavm", entrypoint: "app.polkavm" },
        modalities: {
          graphics: { abiVersion: 1, profile: "tri2d" },
          generalInput: { abiVersion: 1, controls: [] },
        },
      }),
    );
    expect(() =>
      isPvmPackage({
        "manifest.json": manifest,
        "app.polkavm": new Uint8Array([1]),
      }),
    ).toThrow(/only framebuffer ABI version 1/);
  });
});
