// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Build-time plugin: write the build name, package version and hash to
// `host_version.json` at the bundle root, so each origin's deploy can be
// checked with curl. The root, not /assets/, which nginx caches as immutable.

import type { Plugin } from "vite";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * CI injects `VITE_COMMIT_SHA`; a local build falls back to git HEAD. Outside a
 * git checkout (e.g. the docker build, whose context excludes .git) it stays
 * unset, which every reader treats as "dev".
 */
export function ensureCommitSha(): void {
  if ((process.env.VITE_COMMIT_SHA ?? "") !== "") {
    return;
  }
  const head = gitHead();
  if (head !== undefined) {
    process.env.VITE_COMMIT_SHA = head;
  }
}

function gitHead(): string | undefined {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: import.meta.dirname,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

export function readPackageVersion(dir: string): string {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(dir, "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function buildInfo(build: "host" | "app" | "protocol"): Plugin {
  let root = "";
  return {
    name: "dotli-build-info",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    generateBundle() {
      const info = {
        build,
        version: readPackageVersion(root),
        hash: process.env.VITE_COMMIT_SHA ?? "dev",
      };
      this.emitFile({
        type: "asset",
        fileName: "host_version.json",
        source: `${JSON.stringify(info)}\n`,
      });
    },
  };
}
