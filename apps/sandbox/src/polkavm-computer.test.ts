// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  computerNetworkEnabled,
  createNetworkPermissionSession,
  createRetryableLazyPromise,
  decodeFilesystem,
  encodeFilesystem,
  ensureComputerDatabaseStores,
  expectedComputerHostOrigin,
  type FilesystemMetadata,
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
      expectedComputerHostOrigin("dot.li", "https:", "", "dot.li", null, ""),
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

  it("round-trips files with their filesystem metadata", () => {
    const metadata: FilesystemMetadata = {
      version: 1,
      nextInode: "4",
      clockNs: "2000000",
      entries: [
        {
          path: "/home",
          kind: 2,
          mtimeNs: "1000000",
          inode: "2",
        },
        {
          path: "/home/notes.txt",
          kind: 1,
          mtimeNs: "2000000",
          inode: "3",
        },
      ],
    };
    const files = new Map([
      ["/home/notes.txt", new Uint8Array([0, 1, 2, 255])],
    ]);

    const encoded = encodeFilesystem(files, metadata);
    expect(encoded).not.toBeNull();
    const decoded = decodeFilesystem(encoded ?? new Uint8Array());

    expect(decoded.metadata).toEqual(metadata);
    expect([...decoded.files]).toEqual([...files]);
  });

  it("rejects a truncated filesystem record", () => {
    const metadata: FilesystemMetadata = {
      version: 1,
      nextInode: "2",
      clockNs: "0",
      entries: [],
    };
    const encoded = encodeFilesystem(
      new Map([["/home/data", new Uint8Array([1, 2, 3])]]),
      metadata,
    );
    expect(encoded).not.toBeNull();
    expect(() =>
      decodeFilesystem((encoded ?? new Uint8Array()).subarray(0, -1)),
    ).toThrow("truncated computer filesystem save");
  });

  it("loads v1 filesystem records without metadata", () => {
    const path = new TextEncoder().encode("/home/legacy.txt");
    const contents = new Uint8Array([4, 5, 6]);
    const record = new Uint8Array(
      1 + 4 + path.byteLength + 4 + contents.length,
    );
    const view = new DataView(record.buffer);
    record[0] = 1;
    view.setUint32(1, path.byteLength, true);
    record.set(path, 5);
    const contentsOffset = 5 + path.byteLength;
    view.setUint32(contentsOffset, contents.byteLength, true);
    record.set(contents, contentsOffset + 4);

    const decoded = decodeFilesystem(record);
    expect(decoded.metadata).toBeNull();
    expect(decoded.files.get("/home/legacy.txt")).toEqual(contents);
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
    const request = (): Promise<boolean> => {
      requests += 1;
      return Promise.resolve(true);
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
      session.decide("two.example", () => {
        requests += 1;
        return Promise.resolve(true);
      }),
    ).resolves.toBe(false);
    expect(requests).toBe(1);

    first.resolve(true);
    await expect(pending).resolves.toBe(true);
    await expect(
      session.decide("two.example", () => {
        requests += 1;
        return Promise.resolve(true);
      }),
    ).resolves.toBe(true);
    await expect(
      session.decide("three.example", () => {
        requests += 1;
        return Promise.resolve(true);
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
