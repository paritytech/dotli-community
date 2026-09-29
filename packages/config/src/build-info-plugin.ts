// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Build-time plugin: write the build name, package version and a hash of the
// bundle's contents to `host_version.json` at the bundle root, so each origin's
// deploy can be checked with curl. The root, not /assets/, which nginx caches
// as immutable.

import type { Plugin } from "vite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
    // Post, so every other plugin has emitted into the bundle and the hash
    // covers the final bytes. Files outside the bundle are not part of it: the
    // copied public/ dir and the service workers, written after it.
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const hash = createHash("sha256");
        for (const fileName of Object.keys(bundle).sort()) {
          const output = bundle[fileName];
          hash.update(`${fileName}\0`);
          hash.update(output.type === "chunk" ? output.code : output.source);
          hash.update("\0");
        }
        const info = {
          build,
          version: readPackageVersion(root),
          hash: hash.digest("hex"),
        };
        this.emitFile({
          type: "asset",
          fileName: "host_version.json",
          source: `${JSON.stringify(info)}\n`,
        });
      },
    },
  };
}
