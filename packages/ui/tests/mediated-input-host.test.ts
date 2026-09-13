// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi, type Mock } from "vitest";
import {
  MEDIATED_INPUT_STATUS,
  MediatedInputHost,
  type MediatedInputHostDependencies,
  type MediatedInputRequest,
  validatedMediatedInputRequest,
} from "../src/mediated-input-host";

const request: MediatedInputRequest = {
  handle: 7,
  kind: "camera-ur",
  mediaType: "x-zklock-authorization",
  maxBytes: 32,
};

interface HostFixture {
  input: MediatedInputHost;
  send: Mock<MediatedInputHostDependencies["send"]>;
  scan: Mock<MediatedInputHostDependencies["scan"]>;
}

function host(
  overrides: Partial<MediatedInputHostDependencies> = {},
): HostFixture {
  const send = vi.fn<MediatedInputHostDependencies["send"]>();
  const scan = vi.fn<MediatedInputHostDependencies["scan"]>();
  scan.mockResolvedValue(new Uint8Array([1, 2, 3]));
  return {
    send,
    scan,
    input: new MediatedInputHost({
      authorize: async () => true,
      scan,
      send,
      isCancellation: () => false,
      isPermissionDenied: () => false,
      ...overrides,
    }),
  };
}

describe("validatedMediatedInputRequest", () => {
  it("accepts only the bounded camera-UR wire shape", () => {
    const value = {
      type: "dotli:polkavm-mediated-input-request",
      ...request,
    };
    expect(validatedMediatedInputRequest(value)).toEqual(request);
    expect(validatedMediatedInputRequest({ ...value, extra: true })).toBeNull();
    expect(validatedMediatedInputRequest({ ...value, maxBytes: 0 })).toBeNull();
    expect(
      validatedMediatedInputRequest({ ...value, mediaType: "Bad Type" }),
    ).toBeNull();
  });
});

describe("MediatedInputHost", () => {
  it("delivers decoded bytes only after authorization", async () => {
    const owner = {};
    const { input, scan, send } = host();
    input.request(owner, "zklock", request);

    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(scan).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      owner,
      request.handle,
      MEDIATED_INPUT_STATUS.ready,
      new Uint8Array([1, 2, 3]),
    );
  });

  it("reports policy denial without opening the camera", async () => {
    const owner = {};
    const { input, scan, send } = host({ authorize: async () => false });
    input.request(owner, "zklock", request);

    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(scan).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      owner,
      request.handle,
      MEDIATED_INPUT_STATUS.permissionDenied,
      undefined,
    );
  });

  it("reports browser camera denial as permission denied", async () => {
    const owner = {};
    const denied = new Error("browser denied camera access");
    const state = host({
      scan: async () => {
        throw denied;
      },
      isPermissionDenied: (error) => error === denied,
    });
    state.input.request(owner, "zklock", request);

    await vi.waitFor(() => expect(state.send).toHaveBeenCalledOnce());
    expect(state.send).toHaveBeenCalledWith(
      owner,
      request.handle,
      MEDIATED_INPUT_STATUS.permissionDenied,
      undefined,
    );
  });

  it("stops capture silently when the guest cancels", async () => {
    const owner = {};
    const pending = Promise.withResolvers<Uint8Array>();
    const scan = vi.fn<MediatedInputHostDependencies["scan"]>(
      async (_label, _request, signal) => {
        signal.addEventListener("abort", () => pending.reject(signal.reason), {
          once: true,
        });
        return pending.promise;
      },
    );
    const state = host({ scan });
    state.input.request(owner, "zklock", request);
    await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());
    state.input.cancel(owner, request.handle);

    await Promise.resolve();
    expect(scan.mock.calls[0]?.[2].aborted).toBe(true);
    expect(state.send).not.toHaveBeenCalled();
  });

  it("maps scanner cancellation and oversized results to terminal failures", async () => {
    const owner = {};
    const cancelled = host({
      scan: async () => {
        throw new Error("cancelled");
      },
      isCancellation: () => true,
    });
    cancelled.input.request(owner, "zklock", request);
    await vi.waitFor(() => expect(cancelled.send).toHaveBeenCalledOnce());
    expect(cancelled.send.mock.calls[0]?.[2]).toBe(
      MEDIATED_INPUT_STATUS.cancelled,
    );

    const oversized = host({
      scan: async () => new Uint8Array(request.maxBytes + 1),
    });
    oversized.input.request(owner, "zklock", request);
    await vi.waitFor(() => expect(oversized.send).toHaveBeenCalledOnce());
    expect(oversized.send.mock.calls[0]?.[2]).toBe(
      MEDIATED_INPUT_STATUS.failed,
    );
  });
});
