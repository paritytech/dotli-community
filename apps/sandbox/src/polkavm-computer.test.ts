// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  computerNetworkEnabled,
  createNetworkPermissionSession,
  createRetryableLazyPromise,
  ensureComputerDatabaseStores,
  expectedComputerHostOrigin,
} from "./polkavm-computer-contract";
import {
  assertNoHostOwnedPaths,
  shadowsHostOwnedPath,
} from "./host-owned-paths";

describe("PolkaVM computer host boundary", () => {
  it("derives the exact production host without browser-only ancestry APIs", () => {
    expect(
      expectedComputerHostOrigin(
        "terminal.app.dot.li",
        "https:",
        "",
        "dot.li",
        null,
        "",
      ),
    ).toBe("https://terminal.dot.li");
    expect(
      expectedComputerHostOrigin(
        "terminal.app.dot.li",
        "https:",
        "",
        "dot.li",
        "https://terminal.dot.li",
        "https://terminal.dot.li/path",
      ),
    ).toBe("https://terminal.dot.li");
    expect(
      expectedComputerHostOrigin(
        "terminal.app.dot.li",
        "https:",
        "",
        "dot.li",
        "https://evil.app.attacker.example",
        "",
      ),
    ).toBeNull();
    expect(
      expectedComputerHostOrigin(
        "terminal.app.dot.li",
        "https:",
        "",
        "dot.li",
        null,
        "https://other.dot.li",
      ),
    ).toBeNull();
    expect(
      expectedComputerHostOrigin(
        "terminal.app.dot.li",
        "http:",
        "",
        "dot.li",
        null,
        "",
      ),
    ).toBeNull();
    expect(
      expectedComputerHostOrigin(
        "dot.li",
        "https:",
        "",
        "dot.li",
        null,
        "",
      ),
    ).toBeNull();
  });

  it("pins localhost replies to the derived product host and port", () => {
    expect(
      expectedComputerHostOrigin(
        "terminal.app.localhost",
        "http:",
        "5173",
        "dot.li",
        null,
        "",
      ),
    ).toBe("http://terminal.localhost:5173");
    expect(
      expectedComputerHostOrigin(
        "terminal.app.localhost",
        "http:",
        "5173",
        "dot.li",
        "http://terminal.localhost:5173",
        "",
      ),
    ).toBe("http://terminal.localhost:5173");
    expect(
      expectedComputerHostOrigin(
        "terminal.app.localhost",
        "http:",
        "5173",
        "dot.li",
        "http://localhost:5173",
        "",
      ),
    ).toBeNull();
  });

  it("retries a rejected lazy handshake while caching a successful one", async () => {
    const client = { connected: true };
    let attempts = 0;
    const connect = createRetryableLazyPromise(() => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(new Error("transient handshake failure"));
      }
      return Promise.resolve(client);
    });

    await expect(connect()).rejects.toThrow("transient handshake failure");
    await expect(connect()).resolves.toBe(client);
    await expect(connect()).resolves.toBe(client);
    expect(attempts).toBe(2);
  });
});

describe("PolkaVM computer storage", () => {
  it("creates both v2 stores and preserves stores that already exist", () => {
    const stores = new Set(["saves"]);
    const created: string[] = [];
    const database = {
      objectStoreNames: { contains: (name: string) => stores.has(name) },
      createObjectStore(name: string) {
        stores.add(name);
        created.push(name);
      },
    };

    ensureComputerDatabaseStores(database);
    expect(created).toEqual(["translations"]);
    expect([...stores].sort()).toEqual(["saves", "translations"]);

    ensureComputerDatabaseStores(database);
    expect(created).toEqual(["translations"]);
  });
});

describe("PolkaVM computer network permissions", () => {
  it("keeps networking disabled unless both capability and relay exist", () => {
    expect(computerNetworkEnabled(true, "")).toBe(false);
    expect(computerNetworkEnabled(false, "wss://relay.example")).toBe(false);
    expect(computerNetworkEnabled(true, "wss://relay.example")).toBe(true);
  });

  it("memoizes a domain decision only within one session", async () => {
    const session = createNetworkPermissionSession(4, 2);
    let requests = 0;
    const request = async (): Promise<boolean> => {
      requests += 1;
      return true;
    };

    await expect(session.decide("API.Example.", request)).resolves.toBe(true);
    await expect(session.decide("api.example", request)).resolves.toBe(true);
    expect(requests).toBe(1);

    const nextSession = createNetworkPermissionSession(4, 2);
    await expect(nextSession.decide("api.example", request)).resolves.toBe(
      true,
    );
    expect(requests).toBe(2);
  });

  it("bounds distinct domains and concurrent permission requests", async () => {
    const session = createNetworkPermissionSession(2, 1);
    const first = Promise.withResolvers<boolean>();
    let requests = 0;
    const pending = session.decide("one.example", () => {
      requests += 1;
      return first.promise;
    });
    await Promise.resolve();

    await expect(
      session.decide("two.example", async () => {
        requests += 1;
        return true;
      }),
    ).resolves.toBe(false);
    expect(requests).toBe(1);

    first.resolve(true);
    await expect(pending).resolves.toBe(true);
    await expect(
      session.decide("two.example", async () => {
        requests += 1;
        return true;
      }),
    ).resolves.toBe(true);
    await expect(
      session.decide("three.example", async () => {
        requests += 1;
        return true;
      }),
    ).resolves.toBe(false);
    expect(requests).toBe(2);
  });
});

describe("host-owned archive paths", () => {
  it("reserves the host-owned runtime tree", () => {
    expect(
      shadowsHostOwnedPath("polkavm-runtime/polkavm-computer-worker.js"),
    ).toBe(true);
    expect(shadowsHostOwnedPath("/polkavm-runtime/polkavm-worker.js")).toBe(
      true,
    );
    expect(shadowsHostOwnedPath("assets/polkavm-computer-worker.js")).toBe(
      false,
    );
    expect(() => {
      assertNoHostOwnedPaths([
        "index.html",
        "polkavm-runtime/polkavm-computer-worker.js",
      ]);
    }).toThrow("archive path is reserved by the host");
  });
});
