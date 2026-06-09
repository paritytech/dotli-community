// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import {
  parseSettingsFromSearch,
  writeSettingsToSearch,
} from "@dotli/config/url-settings";
import { NetworkName } from "@dotli/config/network";

const globalAny = globalThis as { SharedWorker?: unknown };

function withSharedWorker<T>(present: boolean, fn: () => T): T {
  const hadPrior = "SharedWorker" in globalAny;
  const prior = globalAny.SharedWorker;
  if (present) {
    globalAny.SharedWorker = class {};
  } else if (hadPrior) {
    delete globalAny.SharedWorker;
  }
  try {
    return fn();
  } finally {
    if (hadPrior) {
      globalAny.SharedWorker = prior;
    } else {
      delete globalAny.SharedWorker;
    }
  }
}

describe("parseSettingsFromSearch", () => {
  it("returns nulls for absent or invalid values", () => {
    const empty = parseSettingsFromSearch(new URLSearchParams());
    expect(empty).toEqual({
      network: null,
      chainBackend: null,
      skipArchiveCache: null,
      skipCidCache: null,
      skipWorkerCache: null,
    });

    const invalid = parseSettingsFromSearch(
      new URLSearchParams("network=bogus&chainBackend=nope&skipCidCache=true"),
    );
    expect(invalid.network).toBeNull();
    expect(invalid.chainBackend).toBeNull();
    expect(invalid.skipCidCache).toBeNull();
  });

  it("returns the typed value for each valid axis", () => {
    const parsed = parseSettingsFromSearch(
      new URLSearchParams(
        "network=paseo-next-v2&chainBackend=rpc-gateway&skipArchiveCache=0&skipCidCache=1&skipWorkerCache=1",
      ),
    );
    expect(parsed.network).toBe(NetworkName.PASEO_NEXT_V2);
    expect(parsed.chainBackend).toBe("rpc-gateway");
    expect(parsed.skipArchiveCache).toBe(false);
    expect(parsed.skipCidCache).toBe(true);
    expect(parsed.skipWorkerCache).toBe(true);
  });

  it("returns chainBackend=smoldot-shared-worker when SharedWorker is available", () => {
    withSharedWorker(true, () => {
      const parsed = parseSettingsFromSearch(
        new URLSearchParams("chainBackend=smoldot-shared-worker"),
      );
      expect(parsed.chainBackend).toBe("smoldot-shared-worker");
    });
  });

  it("treats chainBackend=smoldot-shared-worker as absent when SharedWorker is missing", () => {
    withSharedWorker(false, () => {
      const parsed = parseSettingsFromSearch(
        new URLSearchParams("chainBackend=smoldot-shared-worker"),
      );
      expect(parsed.chainBackend).toBeNull();
    });
  });
});

describe("writeSettingsToSearch with environment-aware default", () => {
  it("strips chainBackend when value matches detected default (SharedWorker available)", () => {
    withSharedWorker(true, () => {
      const search = new URLSearchParams("chainBackend=smoldot-shared-worker");
      const changed = writeSettingsToSearch(
        {
          network: NetworkName.PASEO_NEXT_V1,
          chainBackend: "smoldot-shared-worker",
          cache: {
            skipCidCache: true,
            skipArchiveCache: true,
            skipWorkerCache: false,
          },
        },
        search,
      );
      expect(changed).toBe(true);
      expect(search.get("chainBackend")).toBeNull();
    });
  });

  it("keeps chainBackend=smoldot-direct in the URL when default is smoldot-shared-worker", () => {
    withSharedWorker(true, () => {
      const search = new URLSearchParams();
      writeSettingsToSearch(
        {
          network: NetworkName.PASEO_NEXT_V1,
          chainBackend: "smoldot-direct",
          cache: {
            skipCidCache: true,
            skipArchiveCache: true,
            skipWorkerCache: false,
          },
        },
        search,
      );
      expect(search.get("chainBackend")).toBe("smoldot-direct");
    });
  });

  it("strips chainBackend=smoldot-direct when SharedWorker is missing (env default)", () => {
    withSharedWorker(false, () => {
      const search = new URLSearchParams("chainBackend=smoldot-direct");
      writeSettingsToSearch(
        {
          network: NetworkName.PASEO_NEXT_V1,
          chainBackend: "smoldot-direct",
          cache: {
            skipCidCache: true,
            skipArchiveCache: true,
            skipWorkerCache: false,
          },
        },
        search,
      );
      expect(search.get("chainBackend")).toBeNull();
    });
  });
});

describe("writeSettingsToSearch", () => {
  it("drops default-valued axes and preserves unrelated params", () => {
    const search = new URLSearchParams(
      "network=paseo-next-v1&chainBackend=rpc-gateway&skipArchiveCache=1&keep=me",
    );
    const changed = writeSettingsToSearch(
      {
        network: NetworkName.PASEO_NEXT_V2,
        chainBackend: "smoldot-direct",
        cache: {
          skipCidCache: false,
          skipArchiveCache: false,
          skipWorkerCache: false,
        },
      },
      search,
    );
    expect(changed).toBe(true);
    expect(search.get("network")).toBeNull();
    expect(search.get("chainBackend")).toBeNull();
    expect(search.get("skipArchiveCache")).toBeNull();
    expect(search.get("skipWorkerCache")).toBeNull();
    expect(search.get("keep")).toBe("me");
  });

  it("keeps non-default axes with explicit boolean encoding", () => {
    const search = new URLSearchParams();
    writeSettingsToSearch(
      {
        network: NetworkName.PASEO_NEXT_V1,
        chainBackend: "smoldot-direct",
        cache: {
          skipCidCache: true,
          skipArchiveCache: false,
          skipWorkerCache: false,
        },
      },
      search,
    );
    expect(search.get("network")).toBe(NetworkName.PASEO_NEXT_V1);
    expect(search.get("chainBackend")).toBeNull();
    expect(search.get("skipCidCache")).toBe("1");
    expect(search.get("skipArchiveCache")).toBeNull();
    expect(search.get("skipWorkerCache")).toBeNull();
  });
});
