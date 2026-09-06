// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  createRetryableLazyPromise,
  expectedComputerHostOrigin,
} from "./polkavm-computer-contract";
import {
  assertNoHostOwnedPaths,
  shadowsHostOwnedPath,
} from "./host-owned-paths";

describe("PolkaVM computer host boundary", () => {
  it("derives only the exact production host origin for the sandbox label", () => {
    expect(
      expectedComputerHostOrigin(
        "terminal.app.dot.li",
        "https://terminal.dot.li",
        "",
        "dot.li",
      ),
    ).toBe("https://terminal.dot.li");
    expect(
      expectedComputerHostOrigin(
        "terminal.app.dot.li",
        "https://evil.app.attacker.example",
        "",
        "dot.li",
      ),
    ).toBeNull();
    expect(
      expectedComputerHostOrigin(
        "terminal.app.dot.li",
        "https://other.dot.li",
        "",
        "dot.li",
      ),
    ).toBeNull();
    expect(
      expectedComputerHostOrigin("terminal.app.dot.li", "null", "", "dot.li"),
    ).toBeNull();
    expect(
      expectedComputerHostOrigin(
        "terminal.app.dot.li",
        "data:text/html,opaque",
        "",
        "dot.li",
      ),
    ).toBeNull();
  });

  it("pins localhost replies to the matching product host and port", () => {
    expect(
      expectedComputerHostOrigin(
        "terminal.app.localhost",
        "http://terminal.localhost:5173",
        "",
        "dot.li",
      ),
    ).toBe("http://terminal.localhost:5173");
    expect(
      expectedComputerHostOrigin(
        "terminal.app.localhost",
        "http://localhost:5173",
        "",
        "dot.li",
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

describe("host-owned archive paths", () => {
  it("reserves the runtime tree and both current and legacy supervisor paths", () => {
    expect(
      shadowsHostOwnedPath("polkavm-runtime/polkavm-computer-worker.js"),
    ).toBe(true);
    expect(shadowsHostOwnedPath("/polkavm-runtime/polkavm-worker.js")).toBe(
      true,
    );
    expect(shadowsHostOwnedPath("polkavm-computer-worker.js")).toBe(true);
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
