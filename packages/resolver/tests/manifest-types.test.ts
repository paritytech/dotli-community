// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  parseExecutableManifest,
  parseRootManifest,
  validateExecutableManifest,
  validateRootManifest,
} from "@dotli/resolver/manifest-types";

const VALID_ROOT = {
  $v: 1,
  displayName: "HackM3",
  description: "A note-taking app",
  icon: { cid: "bafy...icon", format: "png" },
};

const VALID_APP = {
  $v: 1,
  kind: "app",
  appVersion: [1, 0, 0],
};

const VALID_APP_V2 = {
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
};

const VALID_COMPUTER = {
  $v: 2,
  kind: "app",
  appVersion: [0, 1, 0],
  runtime: {
    kind: "polkavm-computer",
    abiVersion: 1,
    entrypoint: "shell.polkavm",
  },
  capabilities: {
    terminal: { abiVersion: 1 },
  },
};

const VALID_WIDGET = {
  $v: 1,
  kind: "widget",
  appVersion: [1, 0, 0],
  dimensions: { height: [2, 4], width: 1 },
};

const VALID_WORKER = {
  $v: 1,
  kind: "worker",
  appVersion: [1, 0, 0],
  entrypoint: "index.js",
  includes: { chat: true, pocket: false },
};

describe("validateRootManifest", () => {
  it("accepts a well-formed root", () => {
    const r = validateRootManifest(VALID_ROOT);
    expect(r.ok).toBe(true);
  });

  it("rejects wrong $v", () => {
    const r = validateRootManifest({ ...VALID_ROOT, $v: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/\$v must be 1/);
  });

  it("rejects empty displayName", () => {
    const r = validateRootManifest({ ...VALID_ROOT, displayName: "" });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown icon.format", () => {
    const r = validateRootManifest({
      ...VALID_ROOT,
      icon: { cid: "bafy", format: "gif" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /icon\.format/.test(e))).toBe(true);
  });

  it("rejects non-object input", () => {
    expect(validateRootManifest(null).ok).toBe(false);
    expect(validateRootManifest("string").ok).toBe(false);
    expect(validateRootManifest([]).ok).toBe(false);
  });
});

describe("validateExecutableManifest", () => {
  it("accepts a valid app manifest", () => {
    expect(validateExecutableManifest(VALID_APP).ok).toBe(true);
  });

  it("accepts App manifest v2 runtime capabilities", () => {
    expect(validateExecutableManifest(VALID_APP_V2).ok).toBe(true);
    expect(
      validateExecutableManifest({
        ...VALID_APP_V2,
        capabilities: {
          ...VALID_APP_V2.capabilities,
          deviceInput: {
            abiVersion: 1,
            requiredFeatures: ["pointer", "motion"],
          },
        },
      }).ok,
    ).toBe(true);
    expect(
      validateExecutableManifest({
        ...VALID_APP_V2,
        capabilities: {
          graphics: VALID_APP_V2.capabilities.graphics,
        },
      }).ok,
    ).toBe(true);
    expect(
      validateExecutableManifest({
        ...VALID_APP_V2,
        capabilities: {
          ...VALID_APP_V2.capabilities,
          graphics: {
            abiVersion: 1,
            profile: "webgpu",
            requiredFeatures: [],
            requiredLimits: {
              maxBufferSize: 1_048_576,
              maxStorageBufferBindingSize: 1_048_576,
              maxStorageBuffersPerShaderStage: 2,
              maxComputeInvocationsPerWorkgroup: 64,
              maxComputeWorkgroupSizeX: 64,
              maxComputeWorkgroupsPerDimension: 1_024,
            },
          },
        },
      }).ok,
    ).toBe(true);
    expect(
      validateExecutableManifest({
        $v: 2,
        kind: "app",
        appVersion: [1, 0, 0],
        runtime: { kind: "web", entrypoint: "index.html" },
      }).ok,
    ).toBe(true);
    expect(
      validateExecutableManifest({
        ...VALID_APP_V2,
        runtime: {
          ...VALID_APP_V2.runtime,
          fallback: { kind: "web", entrypoint: "fallback/index.html" },
        },
      }).ok,
    ).toBe(true);
  });

  it("rejects unsafe App v2 entrypoints and unknown required features", () => {
    expect(
      validateExecutableManifest({
        ...VALID_APP_V2,
        runtime: { ...VALID_APP_V2.runtime, entrypoint: "../app.polkavm" },
      }).ok,
    ).toBe(false);
    expect(
      validateExecutableManifest({
        ...VALID_APP_V2,
        runtime: {
          ...VALID_APP_V2.runtime,
          fallback: { kind: "web", entrypoint: "../fallback.html" },
        },
      }).ok,
    ).toBe(false);
    expect(
      validateExecutableManifest({
        ...VALID_APP_V2,
        capabilities: {
          ...VALID_APP_V2.capabilities,
          audio: { abiVersion: 1, requiredFeatures: ["spatial"] },
        },
      }).ok,
    ).toBe(false);
  });

  it("accepts a minimal computer manifest", () => {
    expect(validateExecutableManifest(VALID_COMPUTER).ok).toBe(true);
  });

  it("accepts a computer manifest with packages", () => {
    expect(
      validateExecutableManifest({
        ...VALID_COMPUTER,
        capabilities: {
          terminal: { abiVersion: 1 },
          packages: [
            { name: "vim", path: "vim.polkavm" },
            { name: "busybox-1", path: "tools/busybox.polkavm" },
          ],
        },
      }).ok,
    ).toBe(true);
  });

  it("rejects computer terminal with wrong abiVersion", () => {
    expect(
      validateExecutableManifest({
        ...VALID_COMPUTER,
        capabilities: { terminal: { abiVersion: 2 } },
      }).ok,
    ).toBe(false);
  });

  it("rejects computer manifest without terminal capability", () => {
    expect(
      validateExecutableManifest({
        ...VALID_COMPUTER,
        capabilities: {},
      }).ok,
    ).toBe(false);
  });

  it("rejects duplicate computer package names", () => {
    expect(
      validateExecutableManifest({
        ...VALID_COMPUTER,
        capabilities: {
          terminal: { abiVersion: 1 },
          packages: [
            { name: "vim", path: "vim.polkavm" },
            { name: "vim", path: "vim2.polkavm" },
          ],
        },
      }).ok,
    ).toBe(false);
  });

  it("rejects invalid computer package names", () => {
    for (const name of ["Vim", "-vim", "vim!", "", "a".repeat(33)]) {
      expect(
        validateExecutableManifest({
          ...VALID_COMPUTER,
          capabilities: {
            terminal: { abiVersion: 1 },
            packages: [{ name, path: "pkg.polkavm" }],
          },
        }).ok,
      ).toBe(false);
    }
  });

  it("rejects unsafe computer package paths", () => {
    for (const path of ["/vim.polkavm", "../vim.polkavm"]) {
      expect(
        validateExecutableManifest({
          ...VALID_COMPUTER,
          capabilities: {
            terminal: { abiVersion: 1 },
            packages: [{ name: "vim", path }],
          },
        }).ok,
      ).toBe(false);
    }
  });

  it("rejects computer package path equal to the entrypoint", () => {
    expect(
      validateExecutableManifest({
        ...VALID_COMPUTER,
        capabilities: {
          terminal: { abiVersion: 1 },
          packages: [{ name: "shell", path: "shell.polkavm" }],
        },
      }).ok,
    ).toBe(false);
  });

  it("rejects graphics capability on a computer manifest", () => {
    expect(
      validateExecutableManifest({
        ...VALID_COMPUTER,
        capabilities: {
          terminal: { abiVersion: 1 },
          graphics: {
            abiVersion: 1,
            profile: "framebuffer",
            requiredFeatures: [],
          },
        },
      }).ok,
    ).toBe(false);
  });

  it("accepts a valid widget manifest", () => {
    expect(validateExecutableManifest(VALID_WIDGET).ok).toBe(true);
  });

  it("accepts a valid worker manifest", () => {
    expect(validateExecutableManifest(VALID_WORKER).ok).toBe(true);
  });

  it("rejects appVersion of wrong length", () => {
    expect(
      validateExecutableManifest({ ...VALID_APP, appVersion: [1, 0] }).ok,
    ).toBe(false);
    expect(
      validateExecutableManifest({ ...VALID_APP, appVersion: [1, 0, 0, 0, 0] })
        .ok,
    ).toBe(false);
  });

  it("accepts appVersion build-tag as fourth element", () => {
    expect(
      validateExecutableManifest({
        ...VALID_APP,
        appVersion: [1, 0, 0, "alpha"],
      }).ok,
    ).toBe(true);
  });

  it("rejects widget without dimensions.height", () => {
    const broken = {
      ...VALID_WIDGET,
      dimensions: { width: 1 } as { width: number; height?: number[] },
    };
    expect(validateExecutableManifest(broken).ok).toBe(false);
  });

  it("rejects worker entrypoint with leading slash", () => {
    expect(
      validateExecutableManifest({ ...VALID_WORKER, entrypoint: "/index.js" })
        .ok,
    ).toBe(false);
  });

  it("rejects worker with both includes off", () => {
    expect(
      validateExecutableManifest({
        ...VALID_WORKER,
        includes: { chat: false, pocket: false },
      }).ok,
    ).toBe(false);
  });

  it("rejects unknown kind", () => {
    expect(
      validateExecutableManifest({
        $v: 1,
        kind: "daemon",
        appVersion: [1, 0, 0],
        cid: "bafy",
      }).ok,
    ).toBe(false);
  });
});

describe("parse* helpers", () => {
  it("parseRootManifest rejects malformed JSON", () => {
    const r = parseRootManifest("{ not valid");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/not valid JSON/);
  });

  it("parseExecutableManifest accepts a stringified valid app", () => {
    const r = parseExecutableManifest(JSON.stringify(VALID_APP));
    expect(r.ok).toBe(true);
  });
});
