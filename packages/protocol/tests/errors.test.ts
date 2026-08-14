// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  ProtocolFatalError,
  ProtocolInitFailedError,
  ProtocolRequestTimeoutError,
} from "@dotli/protocol/errors";

describe("protocol error types", () => {
  it("constructs ProtocolFatalError with message and name", () => {
    const error = new ProtocolFatalError("smoldot panicked");
    expect(error.name).toBe("ProtocolFatalError");
    expect(error.message).toBe("smoldot panicked");
    expect(error).toBeInstanceOf(Error);
  });

  it("constructs ProtocolInitFailedError with message and name", () => {
    const error = new ProtocolInitFailedError("failed to init");
    expect(error.name).toBe("ProtocolInitFailedError");
    expect(error.message).toBe("failed to init");
    expect(error).toBeInstanceOf(Error);
  });

  it.each([
    {
      method: "resolveDotName" as const,
      timeoutMs: 90_000,
      phase: "ready" as const,
      expectedMsg:
        'Protocol request "resolveDotName" timed out after 90000ms while waiting for the protocol frame to become ready',
    },
    {
      method: "authStorageRead" as const,
      timeoutMs: 30_000,
      phase: "load" as const,
      expectedMsg:
        'Protocol request "authStorageRead" timed out after 30000ms while waiting for the host frame to load',
    },
    {
      method: "chainConnect" as const,
      timeoutMs: 30_000,
      phase: "reply" as const,
      expectedMsg:
        'Protocol request "chainConnect" timed out after 30000ms while waiting for a reply',
    },
  ])(
    "constructs ProtocolRequestTimeoutError for $method in $phase phase",
    ({ method, timeoutMs, phase, expectedMsg }) => {
      const error = new ProtocolRequestTimeoutError(method, timeoutMs, phase);
      expect(error.name).toBe("ProtocolRequestTimeoutError");
      expect(error.method).toBe(method);
      expect(error.timeoutMs).toBe(timeoutMs);
      expect(error.phase).toBe(phase);
      expect(error.message).toBe(expectedMsg);
      expect(error).toBeInstanceOf(Error);
    },
  );
});
