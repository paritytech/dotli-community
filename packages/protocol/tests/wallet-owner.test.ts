// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import {
  WALLET_OWNER_BUSY_ERROR,
  createWalletOwner,
  type WalletOwner,
} from "../src/wallet-owner";

// One exclusive Web Lock shared by every simulated tab of a profile.
function sharedLock(): Pick<LockManager, "request"> {
  let held = false;
  const waiters: { run: () => void }[] = [];
  const next = (): void => {
    waiters.shift()?.run();
  };
  const request = ((
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => Promise<unknown>,
  ) =>
    new Promise((resolve, reject) => {
      const run = (): void => {
        held = true;
        callback({ name, mode: "exclusive" })
          .then(resolve, reject)
          .finally(() => {
            held = false;
            next();
          });
      };
      if (!held) {
        run();
        return;
      }
      if (options.ifAvailable === true) {
        callback(null).then(resolve, reject);
        return;
      }
      const waiter = { run };
      waiters.push(waiter);
      options.signal?.addEventListener("abort", () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) {
          waiters.splice(index, 1);
          reject(new DOMException("aborted", "AbortError"));
        }
      });
    })) as LockManager["request"];
  return { request };
}

// BroadcastChannel semantics: a message reaches every other tab, never the sender.
function sharedBus() {
  const members = new Set<(event: MessageEvent) => void>();
  return () => {
    let own: ((event: MessageEvent) => void) | undefined;
    return {
      postMessage(message: unknown) {
        for (const listener of members) {
          if (listener !== own) {
            listener(new MessageEvent("message", { data: message }));
          }
        }
      },
      addEventListener(
        _type: "message",
        listener: (event: MessageEvent) => void,
      ) {
        own = listener;
        members.add(listener);
      },
    };
  };
}

function profile(
  timing: { handoverWaitMs?: number; releaseGraceMs?: number } = {},
) {
  const locks = sharedLock();
  const channel = sharedBus();
  let id = 0;
  return (): WalletOwner =>
    createWalletOwner({
      locks,
      channel: channel(),
      randomId: () => `lease-${String(++id)}`,
      handoverWaitMs: timing.handoverWaitMs ?? 500,
      releaseGraceMs: timing.releaseGraceMs ?? 400,
    });
}

describe("test wallet owner", () => {
  it("gives the first tab the wallet at once and keeps one lease per page", async () => {
    const tab = profile()();

    const first = await tab.handle({ action: "acquire" });
    expect(first).toBeDefined();
    expect(await tab.handle({ action: "acquire" })).toBe(first);
  });

  it("moves the wallet to a new tab once the old owner has stopped", async () => {
    const newTab = profile();
    const owner = newTab();
    const other = newTab();
    const ownerLease = await owner.handle({ action: "acquire" });
    const stopped = vi.fn((lease: string) => {
      void owner.handle({ action: "release", lease });
    });
    owner.onRevoked(stopped);

    const otherLease = await other.handle({ action: "acquire" });

    expect(stopped).toHaveBeenCalledWith(ownerLease);
    expect(otherLease).toBeDefined();
    expect(otherLease).not.toBe(ownerLease);
  });

  it("releases a revoked owner that never confirms, after the grace period", async () => {
    const newTab = profile({ handoverWaitMs: 500, releaseGraceMs: 30 });
    const owner = newTab();
    const other = newTab();
    await owner.handle({ action: "acquire" });
    owner.onRevoked(() => {
      // Frozen or broken page: never releases on its own.
    });

    await expect(other.handle({ action: "acquire" })).resolves.toBeDefined();
  });

  it("refuses with a busy error when the owner does not hand over in time", async () => {
    const newTab = profile({ handoverWaitMs: 30, releaseGraceMs: 500 });
    const owner = newTab();
    const other = newTab();
    await owner.handle({ action: "acquire" });
    owner.onRevoked(() => {});

    await expect(other.handle({ action: "acquire" })).rejects.toMatchObject({
      name: WALLET_OWNER_BUSY_ERROR,
    });
  });

  it("does not disturb tabs that are not running the wallet", async () => {
    const newTab = profile();
    const owner = newTab();
    const bystander = newTab();
    const next = newTab();
    await owner.handle({ action: "acquire" });
    owner.onRevoked((lease) => {
      void owner.handle({ action: "release", lease });
    });
    const bystanderRevoked = vi.fn();
    bystander.onRevoked(bystanderRevoked);

    await next.handle({ action: "acquire" });

    expect(bystanderRevoked).not.toHaveBeenCalled();
  });
});
