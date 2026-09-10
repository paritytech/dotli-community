// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Request budget and deadline enforcement for protocol client methods.
 *
 * Drives requests against a scripted protocol frame test double and asserts
 * that callers wait no longer than their promised budget when the frame is slow
 * or non-responsive, with accurate phase attribution ("load" | "ready" | "reply").
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SITE_ID } from "@dotli/config/config";
import { SHARED_CORE_SESSION_KEY } from "@dotli/protocol/auth-storage";
import {
  clearSharedAuthStorage,
  clearSharedModeStorage,
  readSharedAuthStorage,
  readSharedModeStorage,
  resetProtocolFrame,
  resolveDotNameRemote,
  resolveExecutableManifestRemote,
  resolveOwnerRemote,
  resolveRootManifestRemote,
  subscribeSharedAuthStorage,
  warmupProtocol,
  writeSharedAuthStorage,
  writeSharedModeStorage,
} from "@dotli/protocol/client";
import {
  ProtocolRequestTimeoutError,
  type ProtocolRequestTimeoutPhase,
} from "@dotli/protocol/errors";
import {
  elapse,
  installProtocolFrame,
  READY_SETTLE_CAP_MS,
  settled,
  settleWithin,
  type ProtocolFrame,
} from "./support";

describe("Keeping a protocol request inside the time limit it promises", () => {
  let frame: ProtocolFrame;

  beforeEach(() => {
    vi.useFakeTimers();
    frame = installProtocolFrame();
  });

  afterEach(() => {
    resetProtocolFrame();
    frame.restore();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  interface SlowFrameCase {
    request: string;
    frame: string;
    limitMs: number;
    blamedWait: ProtocolRequestTimeoutPhase;
    calledMethod: string;
    makeRequest: () => Promise<unknown>;
    driveFrame: () => Promise<void>;
    remainingWaitMs: number;
  }

  const slowFrameCases: SlowFrameCase[] = [
    {
      request: "a saved session read",
      frame: "never opens at all",
      limitMs: 30_000,
      blamedWait: "load",
      calledMethod: "authStorageRead",
      makeRequest: () =>
        readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY),
      driveFrame: async () => {},
      remainingWaitMs: 30_000,
    },
    {
      request: "a saved mode read",
      frame: "never opens at all",
      limitMs: 30_000,
      blamedWait: "load",
      calledMethod: "modeStorageRead",
      makeRequest: () => readSharedModeStorage(SITE_ID, "backend"),
      driveFrame: async () => {},
      remainingWaitMs: 30_000,
    },
    {
      request: "a name lookup",
      frame: "opens but never reports itself ready",
      limitMs: 90_000,
      blamedWait: "ready",
      calledMethod: "resolveDotName",
      makeRequest: () => resolveDotNameRemote("alice"),
      driveFrame: async () => {
        frame.open();
      },
      remainingWaitMs: 90_000,
    },
    {
      request: "an owner lookup",
      frame: "opens but never reports itself ready",
      limitMs: 90_000,
      blamedWait: "ready",
      calledMethod: "resolveOwner",
      makeRequest: () => resolveOwnerRemote("alice"),
      driveFrame: async () => {
        frame.open();
      },
      remainingWaitMs: 90_000,
    },
    {
      request: "an executable manifest lookup",
      frame: "opens but never reports itself ready",
      limitMs: 30_000,
      blamedWait: "ready",
      calledMethod: "resolveExecutableManifest",
      makeRequest: () => resolveExecutableManifestRemote("alice", "app"),
      driveFrame: async () => {
        frame.open();
      },
      remainingWaitMs: 30_000,
    },
    {
      request: "a root manifest lookup",
      frame: "opens but never reports itself ready",
      limitMs: 30_000,
      blamedWait: "ready",
      calledMethod: "resolveRootManifest",
      makeRequest: () => resolveRootManifestRemote("alice"),
      driveFrame: async () => {
        frame.open();
      },
      remainingWaitMs: 30_000,
    },
    {
      request: "a saved session read",
      frame: "takes twenty seconds to open and then never answers",
      limitMs: 30_000,
      blamedWait: "reply",
      calledMethod: "authStorageRead",
      makeRequest: () =>
        readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY),
      driveFrame: async () => {
        await elapse(20_000);
        frame.open();
      },
      remainingWaitMs: 10_000,
    },
    {
      request: "a name lookup",
      frame: "becomes ready at ten seconds and then never answers",
      limitMs: 90_000,
      blamedWait: "reply",
      calledMethod: "resolveDotName",
      makeRequest: () => resolveDotNameRemote("alice"),
      driveFrame: async () => {
        frame.open();
        await elapse(10_000);
        frame.ready();
      },
      remainingWaitMs: 80_000,
    },
  ];

  it.each(slowFrameCases)(
    "As someone making $request, I wait no longer than the limit I was promised when the shared frame $frame, and I am told which wait spent it",
    async ({
      makeRequest,
      driveFrame,
      remainingWaitMs,
      calledMethod,
      limitMs,
      blamedWait,
    }) => {
      // Given
      const pending = makeRequest();
      await driveFrame();

      // When
      const isDone = settled(pending);
      if (remainingWaitMs > 1) {
        await elapse(remainingWaitMs - 1);
        expect(isDone()).toBe(false);
      }
      await settleWithin(pending, 10);
      await expect(pending).rejects.toMatchObject({
        name: "ProtocolRequestTimeoutError",
        method: calledMethod,
        timeoutMs: limitMs,
        phase: blamedWait,
      });
    },
  );

  interface SuccessfulRoundtripCase {
    name: string;
    makeRequest: () => Promise<unknown>;
    expectedMethod: string;
    mockResult: unknown;
    expectedResult: unknown;
  }

  const successfulRoundtrips: SuccessfulRoundtripCase[] = [
    {
      name: "authStorageRead",
      makeRequest: () =>
        readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY),
      expectedMethod: "authStorageRead",
      mockResult: "session-token-123",
      expectedResult: "session-token-123",
    },
    {
      name: "authStorageWrite",
      makeRequest: () =>
        writeSharedAuthStorage(SITE_ID, "UserSecrets", "secret-payload"),
      expectedMethod: "authStorageWrite",
      mockResult: undefined,
      expectedResult: undefined,
    },
    {
      name: "authStorageClear",
      makeRequest: () => clearSharedAuthStorage(SITE_ID, "UserSecrets"),
      expectedMethod: "authStorageClear",
      mockResult: undefined,
      expectedResult: undefined,
    },
    {
      name: "modeStorageRead",
      makeRequest: () => readSharedModeStorage(SITE_ID, "backend"),
      expectedMethod: "modeStorageRead",
      mockResult: "smoldot-shared-worker",
      expectedResult: "smoldot-shared-worker",
    },
    {
      name: "modeStorageWrite",
      makeRequest: () =>
        writeSharedModeStorage(SITE_ID, "backend", "rpc-gateway"),
      expectedMethod: "modeStorageWrite",
      mockResult: undefined,
      expectedResult: undefined,
    },
    {
      name: "modeStorageClear",
      makeRequest: () => clearSharedModeStorage(SITE_ID, "backend"),
      expectedMethod: "modeStorageClear",
      mockResult: undefined,
      expectedResult: undefined,
    },
    {
      name: "resolveExecutableManifestRemote",
      makeRequest: () => resolveExecutableManifestRemote("alice", "app"),
      expectedMethod: "resolveExecutableManifest",
      mockResult: { found: true, manifest: { name: "alice-app" } },
      expectedResult: { found: true, manifest: { name: "alice-app" } },
    },
    {
      name: "resolveRootManifestRemote",
      makeRequest: () => resolveRootManifestRemote("alice"),
      expectedMethod: "resolveRootManifest",
      mockResult: { found: true, manifest: { version: 1 } },
      expectedResult: { found: true, manifest: { version: 1 } },
    },
  ];

  it.each(successfulRoundtrips)(
    "As someone calling $name, I receive the result and the budget timer is disarmed",
    async ({ makeRequest, expectedMethod, mockResult, expectedResult }) => {
      // Given
      const pending = makeRequest();
      await frame.boot();

      // When
      const request = frame.requests().find((r) => r.method === expectedMethod);
      expect(request).toBeDefined();
      frame.respond(request!.id, mockResult);

      // Then
      await expect(pending).resolves.toEqual(expectedResult);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("As someone warming the protocol up, I am never cut off, because warming up waits on chain sync", async () => {
    // Given
    const pending = warmupProtocol();
    frame.open();
    await elapse(1);

    // When
    const isDone = settled(pending);
    await elapse(30_000);

    // Then
    expect(isDone()).toBe(false);
    await settleWithin(pending, READY_SETTLE_CAP_MS);
    await expect(pending).rejects.toThrow(
      "Shared protocol iframe timed out (no ready signal)",
    );
    await expect(pending).rejects.not.toBeInstanceOf(
      ProtocolRequestTimeoutError,
    );
  });

  it("As someone whose reply never came, I stop hearing progress for that request once my time has run out", async () => {
    // Given
    const progress = vi.fn();
    const pending = resolveDotNameRemote("alice", progress);
    frame.open();
    frame.ready();

    // When
    await settleWithin(pending, 90_000);
    await expect(pending).rejects.toBeInstanceOf(ProtocolRequestTimeoutError);

    // Then
    const request = frame.requests().at(-1);
    expect(request).toBeDefined();
    progress.mockClear();
    frame.progress(request!.id, "still working");
    await elapse(1);
    expect(progress).not.toHaveBeenCalled();
  });

  it("relays cross-tab auth storage change notifications to subscribed listeners", async () => {
    // Given
    const changes: unknown[] = [];
    const unsubscribe = subscribeSharedAuthStorage((change) => {
      changes.push(change);
    });
    frame.open();
    await elapse(1);

    // When: Frame emits auth-storage-changed
    frame.authStorageChanged(SITE_ID, SHARED_CORE_SESSION_KEY, "updated-token");
    await elapse(1);

    // Then
    expect(changes).toEqual([
      {
        siteId: SITE_ID,
        key: SHARED_CORE_SESSION_KEY,
        value: "updated-token",
      },
    ]);

    // And When: Unsubscribed
    unsubscribe();
    frame.authStorageChanged(SITE_ID, SHARED_CORE_SESSION_KEY, "second-token");
    await elapse(1);

    // Then: No further changes received
    expect(changes).toHaveLength(1);
  });
});
