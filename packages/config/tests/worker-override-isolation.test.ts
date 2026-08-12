// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment node

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// Runtime network config reaches documents through a blocking script that sets
// `globalThis.__DOTLI_NETWORK__`. The protocol SharedWorker has no document, so
// no global, so it builds the plain built-in table — the two tables genuinely
// differ within one session.
//
// That is only safe because the worker reads exclusively fields that cannot be
// overridden. If it ever reads `rpcs` (say a future gateway path inside the
// worker), the document and the worker would silently disagree about which node
// to talk to, which is precisely the class of failure runtime config is built to
// avoid. These tests pin both halves of that invariant so the divergence cannot
// become a real bug unnoticed.

const REPO = resolve(import.meta.dirname, "../../..");

/** Fields a runtime override may set, and therefore may differ per context. */
const OVERRIDABLE_FIELDS = ["label", "rpcs", "ipfsGateways"] as const;

/**
 * The worker and the resolver modules it imports that read the network table.
 * `smoldot.ts` is also imported but reads chain specs, not this table.
 */
const WORKER_GRAPH = [
  "apps/protocol/src/protocol-shared-worker.ts",
  "packages/resolver/src/chains.ts",
  "packages/resolver/src/resolve.ts",
] as const;

function read(relative: string): string {
  return readFileSync(resolve(REPO, relative), "utf8");
}

describe("worker / document override isolation", () => {
  it("As a maintainer, I see the worker read only fields an override cannot change", () => {
    for (const file of WORKER_GRAPH) {
      const source = read(file);
      // Reads off the config, either directly or via a local `cfg`/`dotns` alias.
      const reads = [
        ...source.matchAll(
          /(?:getActiveServicesConfig\(\)|\bcfg)\.(?:relay|assethub|bulletin|people)\.(\w+)/g,
        ),
      ].map((m) => m[1]);

      for (const field of reads) {
        expect(
          OVERRIDABLE_FIELDS as readonly string[],
          `${file} reads .${field} off the network table. That field is ` +
            `overridable, so the worker would see a different value than the ` +
            `documents. Either stop reading it in the worker, or plumb runtime ` +
            `config into the worker so both agree.`,
        ).not.toContain(field);
      }
    }
  });

  it("As a maintainer, I see genesis and dotns stay non-overridable", () => {
    const source = read("packages/config/src/network.ts");

    // Both merges must copy genesis from the built-in rather than the patch.
    const chainMerges = [
      ...source.matchAll(/function merge(?:Chain|Bulletin)\([^]*?\n\}/g),
    ];
    expect(chainMerges.length).toBeGreaterThan(0);
    for (const [body] of chainMerges) {
      expect(body).toContain("genesis: base.genesis");
    }

    // And no merge may accept genesis or dotns as an allowed field.
    const allowLists = [
      ...source.matchAll(/checkFields\(\s*p,\s*(\[[^\]]*\])/g),
    ]
      .map((m) => m[1])
      .join(" ");
    expect(allowLists).not.toContain("genesis");
    expect(allowLists).not.toContain("dotns");
  });
});
