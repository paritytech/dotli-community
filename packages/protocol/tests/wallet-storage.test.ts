// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSharedWalletOperation,
  type SharedWalletOperation,
} from "@dotli/protocol/wallet-storage";
import {
  handleWalletOperation,
  withSharedWalletRevision,
} from "../../../apps/protocol/src/wallet-storage";

// The service uses only request(name, callback), i.e. exclusive locks. Keep
// each named lock held through the callback's asynchronous work, and release
// it on rejection as well as success. This is not a full Web Locks polyfill.
function exclusiveLocks() {
  const queues = new Map<string, Promise<void>>();
  return {
    request<T>(name: string, callback: (lock: Lock) => T | PromiseLike<T>) {
      const previous = queues.get(name) ?? Promise.resolve();
      const result = previous.then(() => callback({ name, mode: "exclusive" }));
      queues.set(
        name,
        result.then(
          () => {},
          () => {},
        ),
      );
      return result;
    },
  };
}

// Public test entropy only. Each call returns a fresh buffer because successful
// imports/migrations deliberately erase their caller-owned input.
const entropy = (byte: number) => new Uint8Array(32).fill(byte);
const operate = (operation: SharedWalletOperation) =>
  handleWalletOperation(operation, () => {});

beforeEach(() => {
  // No database or lock queue survives between tests. Real WebCrypto exercises
  // encryption/decryption and fake-indexeddb's structured cloning of CryptoKeys.
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("navigator", { locks: exclusiveLocks() });
  vi.stubGlobal("crypto", webcrypto);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shared wallet custody", () => {
  it("rejects unknown operation tags and malformed import entropy at the RPC boundary", () => {
    expect(
      isSharedWalletOperation({
        action: "replace",
        expectedVersion: 0,
        secret: entropy(1),
      }),
    ).toBe(false);
    expect(
      isSharedWalletOperation({
        action: "import",
        expectedVersion: 0,
        secret: "not binary entropy",
      }),
    ).toBe(false);
    expect(
      isSharedWalletOperation({
        action: "import",
        expectedVersion: 0,
        secret: entropy(1),
      }),
    ).toBe(true);
  });

  it("allows only one competing replacement at a captured version", async () => {
    const original = await operate({
      action: "import",
      expectedVersion: 0,
      secret: entropy(0),
    });

    // Two tabs act on the same state without awaiting one another. The lock
    // must cover the read, crypto awaits and durable write, not just the read.
    const results = await Promise.allSettled([
      operate({
        action: "import",
        expectedVersion: original.state.version,
        secret: entropy(1),
      }),
      operate({
        action: "import",
        expectedVersion: original.state.version,
        secret: entropy(2),
      }),
    ]);

    expect(results[0].status).toBe("fulfilled");
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: { name: "WalletConflictError" },
    });
    const saved = await operate({ action: "read" });
    expect(saved.secret).toEqual(entropy(1));
    expect(saved.state.version).toBe(original.state.version + 1);
    expect(saved.state.revision).not.toBe(original.state.revision);

    await expect(
      operate({
        action: "delete",
        expectedVersion: original.state.version,
      }),
    ).rejects.toMatchObject({ name: "WalletConflictError" });
    expect(await operate({ action: "read" })).toEqual(saved);
  });

  it("keeps deletion irreversible to legacy migration even after a tab refreshes its version", async () => {
    const original = await operate({
      action: "migrate",
      expectedVersion: 0,
      secret: entropy(0),
      enabled: true,
    });
    const deleted = await operate({
      action: "delete",
      expectedVersion: original.state.version,
    });

    await expect(
      operate({
        action: "migrate",
        expectedVersion: original.state.version,
        secret: entropy(0),
        enabled: true,
      }),
    ).rejects.toMatchObject({ name: "WalletConflictError" });

    // A refreshed version must not turn an old origin-local recovery copy into
    // a first migration. The tombstone, not only compare-and-swap, prevents it.
    const refreshed = await operate({ action: "state" });
    await expect(
      operate({
        action: "migrate",
        expectedVersion: refreshed.state.version,
        secret: entropy(0),
        enabled: true,
      }),
    ).rejects.toMatchObject({ name: "WalletConflictError" });

    const saved = await operate({ action: "read" });
    expect(saved.secret).toBeUndefined();
    expect(saved.state).toEqual(deleted.state);
    expect(saved.state.hasWallet).toBe(false);
    expect(saved.state.enabled).toBe(false);

    // Deliberate import remains possible; migration refusal is not a broken DB
    // or a permanently locked request queue after the preceding rejections.
    const imported = await operate({
      action: "import",
      expectedVersion: saved.state.version,
      secret: entropy(1),
    });
    expect(imported.state.hasWallet).toBe(true);
    expect((await operate({ action: "read" })).secret).toEqual(entropy(1));
  });

  it("preserves existing custody when a different origin-local wallet migrates", async () => {
    const original = await operate({
      action: "migrate",
      expectedVersion: 0,
      secret: entropy(0),
      enabled: true,
    });
    await expect(
      operate({
        action: "migrate",
        expectedVersion: original.state.version,
        secret: entropy(1),
        enabled: false,
      }),
    ).rejects.toMatchObject({ name: "WalletConflictError" });

    const saved = await operate({ action: "read" });
    expect(saved.state).toEqual(original.state);
    expect(saved.secret).toEqual(entropy(0));
  });

  it.each(["replacement", "disconnect", "deletion"] as const)(
    "rejects a queued verified-identity commit after %s",
    async (change) => {
      const original = await operate({
        action: "migrate",
        expectedVersion: 0,
        secret: entropy(0),
        enabled: true,
      });
      let verifiedIdentity: string | null = null;
      await withSharedWalletRevision(original.state.revision, () => {
        verifiedIdentity = "original-owner";
      });
      expect(verifiedIdentity).toBe("original-owner");

      const expectedVersion = original.state.version;
      const mutation: SharedWalletOperation =
        change === "replacement"
          ? { action: "import", expectedVersion, secret: entropy(1) }
          : change === "disconnect"
            ? { action: "enabled", expectedVersion, enabled: false }
            : { action: "delete", expectedVersion };

      // Model a host invalidating its public metadata when the wallet changes,
      // while an old verification response is waiting to save. Start both
      // before either settles: both APIs must use the same exclusive lock.
      const changed = handleWalletOperation(mutation, () => {
        verifiedIdentity = null;
      });
      const staleCommit = withSharedWalletRevision(
        original.state.revision,
        () => {
          verifiedIdentity = "original-owner";
        },
      );
      const [updated] = await Promise.all([
        changed,
        expect(staleCommit).rejects.toMatchObject({
          name: "WalletConflictError",
        }),
      ]);
      expect(verifiedIdentity).toBeNull();

      if (change === "replacement") {
        await withSharedWalletRevision(updated.state.revision, () => {
          verifiedIdentity = "replacement-owner";
        });
        expect(verifiedIdentity).toBe("replacement-owner");
      } else if (change === "disconnect") {
        // Disconnect retains custody and its identity revision. Rejecting the
        // pending save must therefore check enabled state, not just revision.
        expect(updated.state.revision).toBe(original.state.revision);
        expect((await operate({ action: "read" })).secret).toEqual(entropy(0));
      }
    },
  );
});
