// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import {
  encodeMotionTiltSample,
  manifestRequestsMotionTilt,
  setupMotionTilt,
} from "../src/motion-tilt";

describe("motion tilt contract", () => {
  it("detects only the declared optional ABI-v1 feature", () => {
    const manifest = JSON.stringify({
      $v: 2,
      kind: "app",
      capabilities: {
        deviceInput: {
          abiVersion: 1,
          requiredFeatures: ["pointer"],
          optionalFeatures: ["motion-tilt"],
        },
      },
    });
    expect(manifestRequestsMotionTilt(manifest)).toBe(true);
    expect(
      manifestRequestsMotionTilt(manifest.replace("motion-tilt", "gyro")),
    ).toBe(false);
    expect(manifestRequestsMotionTilt(null)).toBe(false);
  });

  it("encodes one exact PMT1 latest-state sample", () => {
    const bytes = encodeMotionTiltSample({
      sequence: 9,
      timestampUs: 123_456n,
      tiltX: -0.25,
      tiltY: 0.75,
      azimuth: 1.5,
    });
    const view = new DataView(bytes.buffer);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("PMT1");
    expect(view.getUint16(4, true)).toBe(1);
    expect(view.getUint16(6, true)).toBe(3);
    expect(view.getUint32(8, true)).toBe(40);
    expect(view.getUint32(12, true)).toBe(9);
    expect(view.getBigUint64(16, true)).toBe(123_456n);
    expect(view.getFloat32(24, true)).toBe(-0.25);
    expect(view.getFloat32(28, true)).toBe(0.75);
    expect(view.getFloat32(32, true)).toBe(1.5);
    expect(view.getUint32(36, true)).toBe(0);
  });

  it("requests browser permission from a click and forwards calibrated samples", async () => {
    const requestMotion = vi.fn(async () => "granted" as const);
    const requestOrientation = vi.fn(async () => "granted" as const);
    vi.stubGlobal("DeviceMotionEvent", {
      requestPermission: requestMotion,
    });
    vi.stubGlobal("DeviceOrientationEvent", {
      requestPermission: requestOrientation,
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const iframe = document.createElement("iframe");
    iframe.src = "https://demo.app.dotli.dev/";
    const postMessage = vi.fn();
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: { postMessage },
    });
    const container = document.createElement("div");
    const cleanup = setupMotionTilt("demo", iframe, container);
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    button?.click();
    await vi.waitFor(() => {
      expect(requestMotion).toHaveBeenCalledOnce();
      expect(requestOrientation).toHaveBeenCalledOnce();
      expect(button?.textContent).toBe("Motion active");
    });

    for (const [beta, gamma] of [
      [60, 10],
      [72, 20],
    ]) {
      const event = new Event("deviceorientation") as DeviceOrientationEvent;
      Object.defineProperties(event, {
        alpha: { value: 90 },
        beta: { value: beta },
        gamma: { value: gamma },
      });
      window.dispatchEvent(event);
    }
    expect(
      postMessage.mock.calls.some(
        ([message]) => message.type === "dotli:pvm-motion-tilt",
      ),
    ).toBe(true);
    cleanup();
    vi.unstubAllGlobals();
  });
});
