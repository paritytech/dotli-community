// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import {
  accumulateRelativePointerDelta,
  HostFrameResponseQueue,
  describePolkaVmPackage,
  encodedInput,
  encodedTextInput,
  encodedMotionSample,
  encodedPointerMotionSample,
  formatPolkaVmMetrics,
  isPolkaVmPackage,
  normalizedPointerDelta,
  postFirstUiPlatformCommand,
  polkavmWebFallbackEntrypoint,
  unsupportedPolkaVmImport,
  validateFiles,
  expectedPolkaVmParentOrigin,
  shouldReloadAfterWake,
  validatedUiPlatformOutput,
  webGpuAdapterMeetsRequirements,
  waitForTruapiPort,
  type HostFrameResponseQueueOptions,
  type TruapiPortScope,
  type TruapiPortTarget,
} from "./polkavm-runtime";

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
      abiVersion: 2,
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

function webGpuRasterAppV2Manifest(): string {
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

function webGpuComputeAppV2Manifest(): string {
  const manifest = JSON.parse(doomAppV2Manifest()) as Record<string, unknown>;
  const capabilities = manifest.capabilities as Record<string, unknown>;
  const graphics = capabilities.graphics as Record<string, unknown>;
  graphics.profile = "webgpu";
  graphics.requiredLimits = {
    maxBufferSize: 1_048_576,
    maxBindingsPerBindGroup: 3,
    maxBindGroups: 1,
    maxStorageBufferBindingSize: 1_048_576,
    maxStorageBuffersPerShaderStage: 2,
    maxComputeInvocationsPerWorkgroup: 64,
    maxComputeWorkgroupSizeX: 64,
    maxComputeWorkgroupsPerDimension: 1_024,
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

describe("PolkaVM advanced input encoding", () => {
  it("chunks UTF-8 text without splitting code points", () => {
    const records = encodedTextInput(8, "hello π");
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(
      new Uint8Array([8, 0x46, 104, 101, 108, 108, 111, 32]),
    );
    expect(records[1]).toEqual(
      new Uint8Array([8, 0x82, 0xcf, 0x80, 0, 0, 0, 0]),
    );
    expect(encodedTextInput(9, "")).toEqual([
      new Uint8Array([9, 0xc0, 0, 0, 0, 0, 0, 0]),
    ]);
    expect(encodedTextInput(10, "a".repeat(4097))).toEqual([]);
  });

  it("encodes signed wheel deltas and focus state", () => {
    const wheel = encodedInput(14, 0, -12, 32000);
    const view = new DataView(wheel.buffer);
    expect(view.getInt16(2, true)).toBe(-12);
    expect(view.getInt16(4, true)).toBe(32000);
    expect(encodedInput(13, 1)).toEqual(
      new Uint8Array([13, 1, 0, 0, 0, 0, 0, 0]),
    );
  });
});

describe("PolkaVM UI platform output", () => {
  const value = {
    cursorIcon: "text",
    mutableTextUnderCursor: true,
    ime: {
      rect: [10, 20, 210, 60],
      cursorRect: [24, 22, 25, 58],
    },
    commands: [
      { type: "copy-text", text: "hello" },
      {
        type: "open-url",
        url: "https://example.test/path",
        newSurface: true,
      },
    ],
  };

  it("validates bounded ABI state and drops guest-only URL controls", () => {
    const output = validatedUiPlatformOutput(value);
    expect(output).toEqual({
      ...value,
      commands: [
        { type: "copy-text", text: "hello" },
        { type: "open-url", url: "https://example.test/path" },
      ],
    });
    expect(
      validatedUiPlatformOutput({ ...value, cursorIcon: "url(javascript:)" }),
    ).toBeNull();
    expect(
      validatedUiPlatformOutput({
        ...value,
        ime: { ...value.ime, cursorRect: [25, 22, 24, 58] },
      }),
    ).toBeNull();
    expect(
      validatedUiPlatformOutput({
        ...value,
        commands: Array.from({ length: 65 }, () => ({
          type: "copy-text",
          text: "",
        })),
      }),
    ).toBeNull();
    expect(
      validatedUiPlatformOutput({
        ...value,
        commands: [{ type: "copy-text", text: "🦀".repeat(16_385) }],
      }),
    ).toBeNull();
    expect(
      validatedUiPlatformOutput({
        ...value,
        commands: [{ type: "open-url", url: "https://example.test/path" }],
      }),
    ).toBeNull();
  });

  it("posts only the first sensitive command to the owning host", () => {
    const output = validatedUiPlatformOutput(value);
    expect(output).not.toBeNull();
    if (output === null) {
      throw new Error("valid UI output was rejected");
    }
    const postMessage = vi.fn();
    expect(
      postFirstUiPlatformCommand(
        output,
        { postMessage },
        "https://chinpokomon-polkavm.westendli.dev",
      ),
    ).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: "dotli:polkavm-ui-command",
        command: { type: "copy-text", text: "hello" },
      },
      "https://chinpokomon-polkavm.westendli.dev",
    );
    const openUrl = output.commands[1];
    expect(openUrl).toBeDefined();
    expect(
      postFirstUiPlatformCommand(
        { ...output, commands: [openUrl] },
        { postMessage },
        "https://chinpokomon-polkavm.westendli.dev",
      ),
    ).toBe(true);
    expect(postMessage).toHaveBeenLastCalledWith(
      {
        type: "dotli:polkavm-ui-command",
        command: {
          type: "open-url",
          url: "https://example.test/path",
        },
      },
      "https://chinpokomon-polkavm.westendli.dev",
    );
    expect(
      postFirstUiPlatformCommand(
        { ...output, commands: [] },
        { postMessage },
        "https://chinpokomon-polkavm.westendli.dev",
      ),
    ).toBe(false);
    expect(postMessage).toHaveBeenCalledTimes(2);
  });
});

describe("MotionSample v1 encoding", () => {
  it("encodes pointer movement as bounded rotation-rate motion", () => {
    const bytes = encodedPointerMotionSample(10, -5, 20, 3, 100);
    const view = new DataView(bytes.buffer);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("PMO1");
    expect(view.getUint16(4, true)).toBe(1);
    expect(view.getUint16(6, true)).toBe(6);
    expect(view.getUint32(8, true)).toBe(48);
    expect(view.getUint32(12, true)).toBe(3);
    expect(view.getFloat64(16, true)).toBe(100);
    expect(view.getFloat32(40, true)).toBeCloseTo(-37.5);
    expect(view.getFloat32(44, true)).toBeCloseTo(75);
  });

  it("encodes finite device motion and rejects malformed samples", () => {
    const bytes = encodedMotionSample({
      flags: 3,
      sequence: 1,
      timestampMs: 20,
      accelerationX: 1,
      accelerationY: 2,
      accelerationZ: 3,
      rotationAlpha: 4,
      rotationBeta: 5,
      rotationGamma: 6,
    });
    expect(new DataView(bytes.buffer).getFloat32(32, true)).toBe(3);
    expect(() =>
      encodedMotionSample({
        flags: 0,
        sequence: 1,
        timestampMs: 20,
        accelerationX: 0,
        accelerationY: 0,
        accelerationZ: 0,
        rotationAlpha: 0,
        rotationBeta: 0,
        rotationGamma: 0,
      }),
    ).toThrow(/invalid MotionSample v1/);
  });
});

describe("PolkaVM parent motion relay", () => {
  it("derives the authenticated parent from the sandbox origin contract", () => {
    expect(
      expectedPolkaVmParentOrigin(
        "chinpokomon-polkavm.app.westendli.dev",
        "https:",
        "",
      ),
    ).toBe("https://chinpokomon-polkavm.westendli.dev");
    expect(
      expectedPolkaVmParentOrigin(
        "chinpokomon-polkavm.app.localhost",
        "http:",
        "5173",
      ),
    ).toBe("http://chinpokomon-polkavm.localhost:5173");
  });

  it("rejects top-level and non-HTTP origins", () => {
    expect(
      expectedPolkaVmParentOrigin("westendli.dev", "https:", ""),
    ).toBeNull();
    expect(
      expectedPolkaVmParentOrigin("app.westendli.dev", "file:", ""),
    ).toBeNull();
  });
});

describe("PolkaVM wake recovery", () => {
  it("reloads a visible WebGPU application after suspension", () => {
    expect(shouldReloadAfterWake(true, "visible", false)).toBe(true);
    expect(shouldReloadAfterWake(false, "visible", false)).toBe(false);
    expect(shouldReloadAfterWake(true, "hidden", false)).toBe(false);
  });

  it("reloads a page restored from the back-forward cache", () => {
    expect(shouldReloadAfterWake(false, "visible", true)).toBe(true);
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
    const display = formatPolkaVmMetrics(metrics);
    expect(display.summary).toBe("PolkaVM / JIT · 59.9 FPS");
    expect(display.summary).not.toContain("Stage");
    expect(display.summary).not.toContain("Translate");
  });

  it("retains diagnostics in the expandable details", () => {
    expect(
      formatPolkaVmMetrics({ ...metrics, backend: "interpreter" }),
    ).toEqual({
      summary: "PolkaVM / Interpreter · 59.9 FPS",
      details:
        "Stage: first-frame\nTranslate 10.0 ms · Compile 5.0 ms\nUpdate p50 0.00 ms · p95 1.00 ms · max 4.00 ms",
    });
  });
});

describe("PolkaVM compatibility errors", () => {
  it("extracts unsupported imports from translated guest failures", () => {
    expect(
      unsupportedPolkaVmImport(
        "translated PolkaVM guest uses unsupported import host_motion_read",
      ),
    ).toBe("host_motion_read");
    expect(
      unsupportedPolkaVmImport(
        "translated CoreVM guest uses unsupported import pvm_unknown",
      ),
    ).toBe("pvm_unknown");
  });

  it("leaves transport and content failures unclassified", () => {
    expect(unsupportedPolkaVmImport("IPFS request timed out")).toBeNull();
  });
});

describe("PolkaVM package recognition", () => {
  it("recognizes the deployed doom.paseo package shape", () => {
    const files = {
      "manifest.json": doomManifest(),
      "app.polkavm": new Uint8Array([1, 2, 3]),
      "game/doom.wad": new Uint8Array([4, 5, 6]),
    };

    expect(isPolkaVmPackage(files)).toBe(true);
    expect(describePolkaVmPackage(files)).toEqual({
      graphicsProfile: "framebuffer",
      webGpuRequirements: null,
      webFallbackPath: null,
      programPath: "app.polkavm",
      controls: ["WASD Move", "Space Fire"],
      inputFeatures: ["pointer", "keyboard", "motion"],
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

    expect(describePolkaVmPackage(files, manifest)).toEqual({
      graphicsProfile: "framebuffer",
      webGpuRequirements: null,
      webFallbackPath: null,
      programPath: "app.polkavm",
      controls: ["Pointer", "Keyboard"],
      inputFeatures: ["pointer", "keyboard"],
      audioEnabled: true,
      requiredAssets: [],
      manifestVersion: 2,
    });
    expect(() => describePolkaVmPackage(files)).toThrow(
      /external App manifest is required/,
    );
    expect(() => describePolkaVmPackage(files, `${manifest}\n`)).toThrow(
      /does not match/,
    );
  });

  it("runs without a required pointer capability", () => {
    const value = JSON.parse(doomAppV2Manifest()) as {
      capabilities: {
        deviceInput?: { requiredFeatures: string[] };
      };
    };
    delete value.capabilities.deviceInput;
    const manifest = JSON.stringify(value);
    const files = {
      "manifest.json": encoder.encode(manifest),
      "app.polkavm": new Uint8Array([1, 2, 3]),
    };
    expect(describePolkaVmPackage(files, manifest)?.inputFeatures).toEqual([]);
    expect(describePolkaVmPackage(files, manifest)?.controls).toEqual([]);
  });

  it("accepts required MotionSample v1 input", () => {
    const value = JSON.parse(doomAppV2Manifest()) as {
      capabilities: {
        deviceInput: { requiredFeatures: string[] };
      };
    };
    value.capabilities.deviceInput.requiredFeatures.push("motion");
    const manifest = JSON.stringify(value);
    const files = {
      "manifest.json": encoder.encode(manifest),
      "app.polkavm": new Uint8Array([1, 2, 3]),
    };
    expect(describePolkaVmPackage(files, manifest)?.controls).toEqual([
      "Pointer",
      "Keyboard",
      "Motion",
    ]);
  });

  it("accepts required text, IME, focus, and wheel input", () => {
    const value = JSON.parse(doomAppV2Manifest()) as {
      capabilities: {
        deviceInput: { requiredFeatures: string[] };
      };
    };
    value.capabilities.deviceInput.requiredFeatures.push(
      "text",
      "ime",
      "focus",
      "wheel",
    );
    const manifest = JSON.stringify(value);
    const files = {
      "manifest.json": encoder.encode(manifest),
      "app.polkavm": new Uint8Array([1, 2, 3]),
    };
    expect(describePolkaVmPackage(files, manifest)?.inputFeatures).toEqual([
      "pointer",
      "keyboard",
      "text",
      "ime",
      "focus",
      "wheel",
    ]);
  });

  it("recognizes strict App manifest v2 Tri2D packages", () => {
    const manifest = tri2dAppV2Manifest();
    const files = {
      "manifest.json": encoder.encode(manifest),
      "app.polkavm": new Uint8Array([1, 2, 3]),
    };
    expect(describePolkaVmPackage(files, manifest)).toEqual({
      graphicsProfile: "tri2d",
      webGpuRequirements: null,
      webFallbackPath: null,
      programPath: "app.polkavm",
      controls: ["Pointer", "Keyboard"],
      inputFeatures: ["pointer", "keyboard"],
      audioEnabled: false,
      requiredAssets: [],
      manifestVersion: 2,
    });
  });

  it("recognizes strict App manifest v2 WebGPU Raster limits", () => {
    const manifest = webGpuRasterAppV2Manifest();
    const files = {
      "manifest.json": encoder.encode(manifest),
      "app.polkavm": new Uint8Array([1, 2, 3]),
    };
    expect(describePolkaVmPackage(files, manifest)).toEqual({
      graphicsProfile: "webgpu-raster",
      webGpuRequirements: {
        requiredFeatures: [],
        requiredLimits: {
          maxTextureDimension2D: 4096,
          maxBufferSize: 1024,
          maxBindingsPerBindGroup: 3,
        },
      },
      webFallbackPath: null,
      programPath: "app.polkavm",
      controls: ["Pointer", "Keyboard"],
      inputFeatures: ["pointer", "keyboard"],
      audioEnabled: false,
      requiredAssets: [],
      manifestVersion: 2,
    });
  });

  it("accepts the deployed GPUI editor within the runtime program ceiling", () => {
    const manifest = webGpuRasterAppV2Manifest();
    const files = {
      "manifest.json": encoder.encode(manifest),
      "app.polkavm": new Uint8Array(51_425_059),
    };
    const descriptor = describePolkaVmPackage(files, manifest);
    if (descriptor === null) {
      throw new Error("GPUI package was not recognized");
    }
    expect(() => {
      validateFiles(files, descriptor);
    }).not.toThrow();
  });

  it("rejects programs beyond the runtime program ceiling", () => {
    const manifest = webGpuRasterAppV2Manifest();
    const files = {
      "manifest.json": encoder.encode(manifest),
      "app.polkavm": new Uint8Array(64 * 1024 * 1024 + 1),
    };
    const descriptor = describePolkaVmPackage(files, manifest);
    if (descriptor === null) {
      throw new Error("oversized package was not recognized");
    }
    expect(() => {
      validateFiles(files, descriptor);
    }).toThrow(/oversized program/);
  });

  it("selects a declared web fallback when WebGPU is unavailable", async () => {
    const value = JSON.parse(webGpuRasterAppV2Manifest()) as {
      runtime: {
        fallback?: { kind: "web"; entrypoint: string };
      };
    };
    value.runtime.fallback = {
      kind: "web",
      entrypoint: "fallback/index.html",
    };
    const manifest = JSON.stringify(value);
    const files = {
      "manifest.json": encoder.encode(manifest),
      "app.polkavm": new Uint8Array([1, 2, 3]),
      "fallback/index.html": encoder.encode("<canvas></canvas>"),
    };
    vi.stubGlobal("navigator", {
      gpu: { requestAdapter: vi.fn(() => Promise.resolve(null)) },
    });
    try {
      expect(describePolkaVmPackage(files, manifest)?.webFallbackPath).toBe(
        "fallback/index.html",
      );
      await expect(polkavmWebFallbackEntrypoint(files, manifest)).resolves.toBe(
        "fallback/index.html",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the primary runtime when the adapter meets its limits", () => {
    const adapter = {
      features: { has: () => false },
      limits: {
        maxTextureDimension2D: 4096,
        maxBufferSize: 1024,
      },
    } as unknown as GPUAdapter;
    expect(
      webGpuAdapterMeetsRequirements(adapter, {
        requiredFeatures: [],
        requiredLimits: {
          maxTextureDimension2D: 4096,
          maxBufferSize: 1024,
        },
      }),
    ).toBe(true);
  });

  it("keeps the PolkaVM program when the adapter satisfies the declared limits", async () => {
    const value = JSON.parse(webGpuRasterAppV2Manifest()) as {
      runtime: { fallback?: { kind: "web"; entrypoint: string } };
    };
    value.runtime.fallback = { kind: "web", entrypoint: "fallback/index.html" };
    const manifest = JSON.stringify(value);
    const files = {
      "manifest.json": encoder.encode(manifest),
      "app.polkavm": new Uint8Array([1, 2, 3]),
      "fallback/index.html": encoder.encode("<canvas></canvas>"),
    };
    vi.stubGlobal("navigator", {
      gpu: {
        requestAdapter: vi.fn(() =>
          Promise.resolve({
            features: new Set<string>(),
            limits: {
              maxTextureDimension2D: 8192,
              maxBufferSize: 268_435_456,
              maxBindingsPerBindGroup: 640,
            },
          }),
        ),
      },
    });
    try {
      await expect(
        polkavmWebFallbackEntrypoint(files, manifest),
      ).resolves.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses a package whose declared web fallback is absent", async () => {
    const value = JSON.parse(webGpuRasterAppV2Manifest()) as {
      runtime: { fallback?: { kind: "web"; entrypoint: string } };
    };
    value.runtime.fallback = { kind: "web", entrypoint: "fallback/index.html" };
    const manifest = JSON.stringify(value);
    const files = {
      "manifest.json": encoder.encode(manifest),
      "app.polkavm": new Uint8Array([1, 2, 3]),
    };
    vi.stubGlobal("navigator", {
      gpu: { requestAdapter: vi.fn(() => Promise.resolve(null)) },
    });
    try {
      await expect(
        polkavmWebFallbackEntrypoint(files, manifest),
      ).rejects.toThrow(/web fallback entrypoint is missing/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("recognizes strict App manifest v2 WebGPU compute limits", () => {
    const manifest = webGpuComputeAppV2Manifest();
    const files = {
      "manifest.json": encoder.encode(manifest),
      "app.polkavm": new Uint8Array([1, 2, 3]),
    };
    expect(describePolkaVmPackage(files, manifest)).toEqual({
      graphicsProfile: "webgpu",
      webGpuRequirements: {
        requiredFeatures: [],
        requiredLimits: {
          maxBufferSize: 1_048_576,
          maxBindingsPerBindGroup: 3,
          maxBindGroups: 1,
          maxStorageBufferBindingSize: 1_048_576,
          maxStorageBuffersPerShaderStage: 2,
          maxComputeInvocationsPerWorkgroup: 64,
          maxComputeWorkgroupSizeX: 64,
          maxComputeWorkgroupsPerDimension: 1_024,
        },
      },
      webFallbackPath: null,
      programPath: "app.polkavm",
      controls: ["Pointer", "Keyboard"],
      inputFeatures: ["pointer", "keyboard"],
      audioEnabled: false,
      requiredAssets: [],
      manifestVersion: 2,
    });
  });

  it("leaves ordinary HTML archives on the existing sandbox path", () => {
    expect(
      isPolkaVmPackage({
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
      isPolkaVmPackage({
        "manifest.json": manifest,
        "app.polkavm": new Uint8Array([1]),
      }),
    ).toThrow(/only framebuffer ABI version 1/);
  });
});

describe("PolkaVM host-frame transport", () => {
  it("adopts an existing Host-injected canonical MessagePort", async () => {
    const channel = new MessageChannel();
    const scope = {
      __HOST_API_PORT__: channel.port1,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } satisfies TruapiPortScope;
    const target = { postMessage: vi.fn() } satisfies TruapiPortTarget;
    await expect(
      waitForTruapiPort(
        scope,
        target,
        "https://chinpokomon-polkavm.westendli.dev",
        0,
      ),
    ).resolves.toBe(channel.port1);
    expect(target.postMessage).not.toHaveBeenCalled();
    channel.port1.close();
    channel.port2.close();
  });

  it("negotiates a transferred Host port only with the owning origin", async () => {
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
    const parentOrigin = "https://chinpokomon-polkavm.westendli.dev";
    const target = {
      postMessage(message: unknown, targetOrigin: string) {
        expect(message).toEqual({ type: "truapi-ready" });
        expect(targetOrigin).toBe(parentOrigin);
        if (listener === null) {
          throw new Error("message listener was not ready");
        }
        listener({
          source: target as unknown as MessageEventSource,
          origin: "https://evil.example",
          data: { type: "truapi-init" },
          ports: [channel.port1],
        } as unknown as MessageEvent<unknown>);
        expect(scope.__HOST_API_PORT__).toBeUndefined();
        listener({
          source: target as unknown as MessageEventSource,
          origin: parentOrigin,
          data: { type: "truapi-init" },
          ports: [channel.port1],
        } as unknown as MessageEvent<unknown>);
      },
    } satisfies TruapiPortTarget;

    await expect(
      waitForTruapiPort(scope, target, parentOrigin, 100),
    ).resolves.toBe(channel.port1);
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
    const parentOrigin = "https://chinpokomon-polkavm.westendli.dev";
    await expect(
      waitForTruapiPort(scope, target, parentOrigin, 0),
    ).rejects.toThrow(/TrUAPI Host port was not available/);
    expect(target.postMessage).toHaveBeenCalledWith(
      { type: "truapi-ready" },
      parentOrigin,
    );
  });
});

describe("PolkaVM host-frame response backpressure", () => {
  function harness(options: HostFrameResponseQueueOptions = {}): {
    queue: HostFrameResponseQueue;
    posted: { bytes: Uint8Array; seq: unknown }[];
    failures: Error[];
    runNextTimer: () => void;
  } {
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    const posted: { bytes: Uint8Array; seq: unknown }[] = [];
    const failures: Error[] = [];
    const queue = new HostFrameResponseQueue(
      {
        postMessage(message: unknown) {
          if (
            message !== null &&
            typeof message === "object" &&
            "bytes" in message &&
            "seq" in message &&
            message.bytes instanceof Uint8Array
          ) {
            posted.push({ bytes: message.bytes, seq: message.seq });
          }
        },
      },
      (error) => failures.push(error),
      {
        setTimer: (callback) => {
          const id = nextTimer++;
          timers.set(id, callback);
          return id;
        },
        clearTimer: (id) => void timers.delete(id),
        ...options,
      },
    );
    const runNextTimer = (): void => {
      const next = timers.entries().next().value;
      if (next === undefined) {
        throw new Error("expected a scheduled timer");
      }
      timers.delete(next[0]);
      next[1]();
    };
    return { queue, posted, failures, runNextTimer };
  }

  it("dequeues responses only on matching accepted acks", () => {
    const { queue, posted, failures } = harness();
    queue.enqueue(Uint8Array.of(1, 2));
    expect(posted).toEqual([]);
    queue.start();
    queue.enqueue(Uint8Array.of(3));
    expect(posted).toEqual([{ bytes: Uint8Array.of(1, 2), seq: 1 }]);
    expect(queue.pendingCount).toBe(2);
    expect(queue.pendingBytes).toBe(3);

    // An accepted ack for a foreign sequence must not settle the delivery.
    expect(
      queue.handleMessage({ type: "host-frame-response-accepted", seq: 999 }),
    ).toBe(true);
    expect(posted).toHaveLength(1);
    expect(queue.pendingCount).toBe(2);

    expect(
      queue.handleMessage({ type: "host-frame-response-accepted", seq: 1 }),
    ).toBe(true);
    expect(queue.pendingCount).toBe(1);
    expect(queue.pendingBytes).toBe(1);
    expect(posted).toEqual([
      { bytes: Uint8Array.of(1, 2), seq: 1 },
      { bytes: Uint8Array.of(3), seq: 2 },
    ]);

    queue.handleMessage({ type: "host-frame-response-accepted", seq: 2 });
    expect(queue.pendingCount).toBe(0);
    expect(queue.pendingBytes).toBe(0);
    expect(failures).toEqual([]);
  });

  it("retains and retries a rejected response before later responses", () => {
    const { queue, posted, failures, runNextTimer } = harness();
    queue.start();
    queue.enqueue(Uint8Array.of(1, 2));
    queue.enqueue(Uint8Array.of(3));

    expect(
      queue.handleMessage({
        type: "host-frame-response-rejected",
        reason: "queue-full",
        seq: 1,
      }),
    ).toBe(true);
    // A rejection is nonfatal and never triggers an immediate re-post.
    expect(posted).toHaveLength(1);
    expect(queue.pendingCount).toBe(2);
    expect(failures).toEqual([]);

    runNextTimer();
    expect(posted).toHaveLength(2);
    // A retried delivery gets a fresh sequence.
    expect(posted[1]).toEqual({ bytes: Uint8Array.of(1, 2), seq: 2 });

    // A late rejection for the superseded sequence must neither drop the
    // in-flight response nor deliver it twice.
    expect(
      queue.handleMessage({
        type: "host-frame-response-rejected",
        reason: "queue-full",
        seq: 1,
      }),
    ).toBe(true);
    expect(posted).toHaveLength(2);
    expect(queue.pendingCount).toBe(2);

    queue.handleMessage({ type: "host-frame-response-accepted", seq: 2 });
    expect(posted).toHaveLength(3);
    expect(posted[2]).toEqual({ bytes: Uint8Array.of(3), seq: 3 });
    expect(queue.pendingCount).toBe(1);

    // A late rejection arriving after its response was accepted is ignored
    // too.
    expect(
      queue.handleMessage({
        type: "host-frame-response-rejected",
        reason: "queue-full",
        seq: 2,
      }),
    ).toBe(true);
    expect(posted).toHaveLength(3);
    expect(queue.pendingCount).toBe(1);

    queue.handleMessage({ type: "host-frame-response-accepted", seq: 3 });
    expect(queue.pendingCount).toBe(0);
    expect(queue.pendingBytes).toBe(0);
    expect(failures).toEqual([]);
  });

  it("fails the session only when bounds are exhausted", () => {
    const overflow = harness({ maxResponses: 1 });
    overflow.queue.start();
    overflow.queue.enqueue(Uint8Array.of(1));
    overflow.queue.enqueue(Uint8Array.of(2));
    expect(overflow.failures).toHaveLength(1);
    expect(overflow.failures[0]?.message).toMatch(/queue overflow/);
    expect(overflow.queue.pendingCount).toBe(0);

    const retried = harness({ maxRetries: 1 });
    retried.queue.start();
    retried.queue.enqueue(Uint8Array.of(9));
    retried.queue.handleMessage({
      type: "host-frame-response-rejected",
      reason: "queue-full",
      seq: 1,
    });
    retried.runNextTimer();
    expect(retried.posted.at(-1)?.seq).toBe(2);
    retried.queue.handleMessage({
      type: "host-frame-response-rejected",
      reason: "queue-full",
      seq: 2,
    });
    expect(retried.failures[0]?.message).toMatch(/retry limit exceeded/);

    const invalid = harness();
    invalid.queue.start();
    invalid.queue.enqueue(Uint8Array.of(7));
    invalid.queue.handleMessage({
      type: "host-frame-response-rejected",
      reason: "nope",
      seq: 1,
    });
    expect(invalid.failures[0]?.message).toMatch(
      /invalid host-frame rejection/,
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
