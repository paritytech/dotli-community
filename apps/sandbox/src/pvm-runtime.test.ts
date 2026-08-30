// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import {
  accumulateRelativePointerDelta,
  describePvmPackage,
  encodedInput,
  formatPvmMetrics,
  isPvmPackage,
  normalizedPointerDelta,
  waitForTruapiPort,
  type TruapiPortScope,
  type TruapiPortTarget,
} from "./pvm-runtime";

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

function tri2dAppV2Manifest(): string {
  const manifest = JSON.parse(doomAppV2Manifest()) as Record<string, unknown>;
  const capabilities = manifest.capabilities as Record<string, unknown>;
  const graphics = capabilities.graphics as Record<string, unknown>;
  graphics.profile = "tri2d";
  delete capabilities.audio;
  return JSON.stringify(manifest);
}

function webGpuAppV2Manifest(): string {
  const manifest = JSON.parse(doomAppV2Manifest()) as Record<string, unknown>;
  const capabilities = manifest.capabilities as Record<string, unknown>;
  const graphics = capabilities.graphics as Record<string, unknown>;
  graphics.profile = "webgpu-raster";
  graphics.requiredLimits = {
    maxTextureDimension2D: 4096,
    maxBufferSize: 1024,
    maxBindingsPerBindGroup: 3,
  };
  delete capabilities.audio;
  return JSON.stringify(manifest);
}

describe("PolkaVM pointer input", () => {
  it("preserves signed pointer deltas for the guest runtime", () => {
    const large = encodedInput(6, 0, 32_000, -32_000);
    const largeView = new DataView(large.buffer);
    expect(largeView.getInt16(2, true)).toBe(32_000);
    expect(largeView.getInt16(4, true)).toBe(-32_000);

    const normal = encodedInput(6, 0, 23, -19);
    const normalView = new DataView(normal.buffer);
    expect(normalView.getInt16(2, true)).toBe(23);
    expect(normalView.getInt16(4, true)).toBe(-19);
  });

  it("coalesces a high-rate pointer backlog into one bounded frame delta", () => {
    let x = 0;
    let y = 0;
    for (let index = 0; index < 64; index++) {
      [x, y] = accumulateRelativePointerDelta(x, y, 5, -3);
    }
    expect([x, y]).toEqual([127, -127]);

    expect(accumulateRelativePointerDelta(x, y, -20, 20)).toEqual([107, -107]);
  });
});

describe("PolkaVM metrics display", () => {
  const metrics = {
    backend: "compiler" as const,
    fps: 59.94,
    startupStage: "first-frame",
    translationMs: 10,
    compilationMs: 5,
    updateP50Ms: 0,
    updateP95Ms: 1,
    updateMaxMs: 4,
  };

  it("keeps the default JIT badge to one concise line", () => {
    const display = formatPvmMetrics(metrics);
    expect(display.summary).toBe("PolkaVM / JIT · 59.9 FPS");
    expect(display.summary).not.toContain("Stage");
    expect(display.summary).not.toContain("Translate");
  });

  it("retains diagnostics in the expandable details", () => {
    expect(formatPvmMetrics({ ...metrics, backend: "interpreter" })).toEqual({
      summary: "PolkaVM / Interpreter · 59.9 FPS",
      details:
        "Stage: first-frame\nTranslate 10.0 ms · Compile 5.0 ms\nUpdate p50 0.00 ms · p95 1.00 ms · max 4.00 ms",
    });
  });
});

describe("PolkaVM package recognition", () => {
  it("recognizes the deployed doom.paseo package shape", () => {
    const files = {
      "manifest.json": doomManifest(),
      "app.polkavm": new Uint8Array([1, 2, 3]),
      "game/doom.wad": new Uint8Array([4, 5, 6]),
    };

    expect(isPvmPackage(files)).toBe(true);
    expect(describePvmPackage(files)).toEqual({
      graphicsProfile: "framebuffer",
      webGpuRequirements: null,
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
      graphicsProfile: "framebuffer",
      webGpuRequirements: null,
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

  it("recognizes strict App manifest v2 Tri2D packages", () => {
    const manifest = tri2dAppV2Manifest();
    const files = {
      "manifest.json": encoder.encode(manifest),
      "app.polkavm": new Uint8Array([1, 2, 3]),
    };
    expect(describePvmPackage(files, manifest)).toEqual({
      graphicsProfile: "tri2d",
      webGpuRequirements: null,
      programPath: "app.polkavm",
      controls: ["Pointer", "Keyboard"],
      audioEnabled: false,
      requiredAssets: [],
      manifestVersion: 2,
    });
  });

  it("recognizes strict App manifest v2 WebGPU Raster limits", () => {
    const manifest = webGpuAppV2Manifest();
    const files = {
      "manifest.json": encoder.encode(manifest),
      "app.polkavm": new Uint8Array([1, 2, 3]),
    };
    expect(describePvmPackage(files, manifest)).toEqual({
      graphicsProfile: "webgpu-raster",
      webGpuRequirements: {
        requiredFeatures: [],
        requiredLimits: {
          maxTextureDimension2D: 4096,
          maxBufferSize: 1024,
          maxBindingsPerBindGroup: 3,
        },
      },
      programPath: "app.polkavm",
      controls: ["Pointer", "Keyboard"],
      audioEnabled: false,
      requiredAssets: [],
      manifestVersion: 2,
    });
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

describe("PolkaVM TrUAPI transport", () => {
  it("adopts an existing Host-injected canonical MessagePort", async () => {
    const channel = new MessageChannel();
    const scope = {
      __HOST_API_PORT__: channel.port1,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } satisfies TruapiPortScope;
    const target = { postMessage: vi.fn() } satisfies TruapiPortTarget;
    await expect(waitForTruapiPort(scope, target, 0)).resolves.toBe(
      channel.port1,
    );
    expect(target.postMessage).not.toHaveBeenCalled();
    channel.port1.close();
    channel.port2.close();
  });

  it("negotiates and adopts a transferred Host port", async () => {
    const channel = new MessageChannel();
    let listener: ((event: MessageEvent<unknown>) => void) | null = null;
    const scope: TruapiPortScope = {
      addEventListener(
        _type: "message",
        next: (event: MessageEvent<unknown>) => void,
      ) {
        listener = next;
      },
      removeEventListener(
        _type: "message",
        current: (event: MessageEvent<unknown>) => void,
      ) {
        if (listener === current) {
          listener = null;
        }
      },
    };
    const target = {
      postMessage(message: unknown, targetOrigin: string) {
        expect(message).toEqual({ type: "truapi-ready" });
        expect(targetOrigin).toBe("*");
        if (listener === null) {
          throw new Error("message listener was not ready");
        }
        listener({
          source: target as unknown as MessageEventSource,
          data: { type: "truapi-init" },
          ports: [channel.port1],
        } as unknown as MessageEvent<unknown>);
      },
    } satisfies TruapiPortTarget;

    await expect(waitForTruapiPort(scope, target, 100)).resolves.toBe(
      channel.port1,
    );
    expect(scope.__HOST_API_PORT__).toBe(channel.port1);
    channel.port1.close();
    channel.port2.close();
  });

  it("fails closed when the Host port is absent", async () => {
    const scope = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } satisfies TruapiPortScope;
    const target = { postMessage: vi.fn() } satisfies TruapiPortTarget;
    await expect(waitForTruapiPort(scope, target, 0)).rejects.toThrow(
      /TrUAPI Host port was not available/,
    );
    expect(target.postMessage).toHaveBeenCalledWith(
      { type: "truapi-ready" },
      "*",
    );
  });
});

describe("pointer lock mouse deltas", () => {
  it("drops the cursor-warp sample after pointer lock acquisition", () => {
    expect(normalizedPointerDelta(80, -40, true)).toBeNull();
  });

  it("preserves deltas representable by the CoreVM mouse ABI", () => {
    expect(normalizedPointerDelta(127, -127, false)).toEqual([127, -127]);
    expect(normalizedPointerDelta(3, -5, false)).toEqual([3, -5]);
  });

  it("drops pointer-lock discontinuities and invalid browser deltas", () => {
    expect(normalizedPointerDelta(430, -314, false)).toBeNull();
    expect(
      normalizedPointerDelta(Number.POSITIVE_INFINITY, 0, false),
    ).toBeNull();
    expect(normalizedPointerDelta(0, Number.NaN, false)).toBeNull();
  });
});
