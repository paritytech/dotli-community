// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Precedence of error conditions over request timeout budgets.
 *
 * Verifies that host frame load failures, light client fatal crashes, and
 * protocol frame teardown events immediately fail in-flight requests with
 * their root-cause error rather than being falsely reported as timeout errors.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetProtocolFrame,
  resolveDotNameRemote,
  resolveExecutableManifestRemote,
  resolveOwnerRemote,
  resolveRootManifestRemote,
} from "@dotli/protocol/client";
import {
  ProtocolFatalError,
  ProtocolRequestTimeoutError,
} from "@dotli/protocol/errors";
import {
  elapse,
  installProtocolFrame,
  settleWithin,
  type ProtocolFrame,
} from "./support";

describe("Error precedence over request timeout budgets", () => {
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

  interface PrecedenceCase {
    name: string;
    makeRequest: () => Promise<unknown>;
  }

  const loadErrorCases: PrecedenceCase[] = [
    {
      name: "resolveOwnerRemote",
      makeRequest: () => resolveOwnerRemote("alice"),
    },
    {
      name: "resolveDotNameRemote",
      makeRequest: () => resolveDotNameRemote("alice"),
    },
  ];

  it.each(loadErrorCases)(
    "As someone making $name, I am told the shared frame failed to load rather than timing out",
    async ({ makeRequest }) => {
      // Given
      const pending = makeRequest();

      // When
      await settleWithin(pending, 90_000);

      // Then
      await expect(pending).rejects.toThrow(
        "Shared host iframe timed out while loading",
      );
      await expect(pending).rejects.not.toBeInstanceOf(
        ProtocolRequestTimeoutError,
      );
    },
  );

  const resetCases: PrecedenceCase[] = [
    {
      name: "resolveDotNameRemote",
      makeRequest: () => resolveDotNameRemote("alice"),
    },
    {
      name: "resolveRootManifestRemote",
      makeRequest: () => resolveRootManifestRemote("alice"),
    },
  ];

  it.each(resetCases)(
    "As someone making $name, I am told the frame was torn down rather than timing out",
    async ({ makeRequest }) => {
      // Given
      const pending = makeRequest();
      frame.open();
      await elapse(1);

      // When
      resetProtocolFrame();

      // Then
      await settleWithin(pending, 1_000);
      await expect(pending).rejects.toThrow(
        "Protocol frame state reset before ready signal",
      );
      await expect(pending).rejects.not.toBeInstanceOf(
        ProtocolRequestTimeoutError,
      );
    },
  );

  const fatalCases: PrecedenceCase[] = [
    {
      name: "resolveDotNameRemote",
      makeRequest: () => resolveDotNameRemote("alice"),
    },
    {
      name: "resolveExecutableManifestRemote",
      makeRequest: () => resolveExecutableManifestRemote("alice", "widget"),
    },
  ];

  it.each(fatalCases)(
    "As someone whose $name encounters a light client crash, I am told it crashed rather than timing out",
    async ({ makeRequest }) => {
      // Given
      const pending = makeRequest();
      frame.open();
      frame.ready();
      await elapse(10_000);

      // When
      frame.fatal("smoldot panicked");

      // Then
      await settleWithin(pending, 1_000);
      await expect(pending).rejects.toBeInstanceOf(ProtocolFatalError);
      await expect(pending).rejects.toThrow("smoldot panicked");
      await expect(pending).rejects.not.toBeInstanceOf(
        ProtocolRequestTimeoutError,
      );
    },
  );
});
