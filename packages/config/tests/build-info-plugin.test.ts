// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInfo } from "@dotli/config/build-info-plugin";

/** Runs the plugin's hooks against `root` and returns what it emitted. */
function emit(root: string): { fileName?: string; source?: unknown } {
  const plugin = buildInfo("host");
  const emitted: { fileName?: string; source?: unknown }[] = [];
  (plugin.configResolved as (config: { root: string }) => void)({ root });
  (plugin.generateBundle as (this: unknown) => void).call({
    emitFile: (file: { fileName?: string; source?: unknown }) => {
      emitted.push(file);
      return "";
    },
  });
  expect(emitted).toHaveLength(1);
  return emitted[0] ?? {};
}

describe("buildInfo", () => {
  let dir: string;
  let savedSha: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dotli-build-info-"));
    savedSha = process.env.VITE_COMMIT_SHA;
    delete process.env.VITE_COMMIT_SHA;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedSha === undefined) {
      delete process.env.VITE_COMMIT_SHA;
    } else {
      process.env.VITE_COMMIT_SHA = savedSha;
    }
  });

  it("emits host_version.json with the build, package version and hash", () => {
    writeFileSync(join(dir, "package.json"), '{"version":"1.2.3"}');
    process.env.VITE_COMMIT_SHA = "abc123";
    const file = emit(dir);
    expect(file.fileName).toBe("host_version.json");
    expect(JSON.parse(file.source as string)).toEqual({
      build: "host",
      version: "1.2.3",
      hash: "abc123",
    });
  });

  it("reports dev and 0.0.0 without a hash or a package.json", () => {
    expect(JSON.parse(emit(dir).source as string)).toEqual({
      build: "host",
      version: "0.0.0",
      hash: "dev",
    });
  });
});
