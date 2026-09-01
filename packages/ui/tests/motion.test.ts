// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  encodeMotionSample,
  motionPermissionStorageKey,
  readMotionPermission,
  setupMotion,
} from "../src/motion";

function motionConstructor(
  requestPermission: () => Promise<"granted" | "denied">,
): typeof DeviceMotionEvent {
  function FakeDeviceMotionEvent(): void {}
  Object.defineProperty(FakeDeviceMotionEvent, "requestPermission", {
    value: requestPermission,
  });
  return FakeDeviceMotionEvent as unknown as typeof DeviceMotionEvent;
}

function productFrame(): {
  iframe: HTMLIFrameElement;
  container: HTMLDivElement;
  postMessage: Mock;
} {
  const iframe = document.createElement("iframe");
  iframe.src = "https://demo.app.dotli.dev/";
  const postMessage = vi.fn();
  Object.defineProperty(iframe, "contentWindow", {
    configurable: true,
    value: { postMessage },
  });
  return { iframe, container: document.createElement("div"), postMessage };
}

function deviceMotionEvent(): DeviceMotionEvent {
  const event = new Event("devicemotion") as DeviceMotionEvent;
  Object.defineProperties(event, {
    accelerationIncludingGravity: {
      value: { x: 1.25, y: -2.5, z: 9.5 },
    },
    rotationRate: {
      value: { alpha: 3, beta: -4, gamma: 5 },
    },
  });
  return event;
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

describe("MotionSample host broker", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("encodes the exact PMO1 MotionSample v1 layout", () => {
    const bytes = encodeMotionSample({
      flags: 3,
      sequence: 9,
      timestampMs: 123.5,
      accelerationX: 1,
      accelerationY: 2,
      accelerationZ: 3,
      rotationAlpha: 4,
      rotationBeta: 5,
      rotationGamma: 6,
    });
    const view = new DataView(bytes.buffer);
    expect(bytes).toHaveLength(48);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("PMO1");
    expect(view.getUint16(4, true)).toBe(1);
    expect(view.getUint16(6, true)).toBe(3);
    expect(view.getUint32(8, true)).toBe(48);
    expect(view.getUint32(12, true)).toBe(9);
    expect(view.getFloat64(16, true)).toBe(123.5);
    expect(view.getFloat32(24, true)).toBe(1);
    expect(view.getFloat32(40, true)).toBe(5);
    expect(view.getFloat32(44, true)).toBe(6);
  });

  it("keeps sensors inactive until a direct user click", async () => {
    const requestPermission = vi.fn(async () => "granted" as const);
    vi.stubGlobal("DeviceMotionEvent", motionConstructor(requestPermission));
    const { iframe, container, postMessage } = productFrame();

    const cleanup = setupMotion(
      "demo",
      "paseo-next-v2",
      iframe,
      container,
      new URL(iframe.src).origin,
    );
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Enable motion");
    expect(requestPermission).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      { type: "dotli:pvm-motion-status", availability: 0 },
      iframe.src.slice(0, -1),
    );

    button?.click();
    await vi.waitFor(() => {
      expect(requestPermission).toHaveBeenCalledOnce();
      expect(button?.textContent).toBe("Motion active");
    });
    window.dispatchEvent(deviceMotionEvent());

    const sampleCall = postMessage.mock.calls.find(
      ([message]) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "dotli:pvm-motion-sample",
    );
    expect(sampleCall).toBeDefined();
    const message = sampleCall?.[0];
    expect(message).toBeTypeOf("object");
    if (
      typeof message !== "object" ||
      message === null ||
      !("bytes" in message) ||
      !(message.bytes instanceof ArrayBuffer)
    ) {
      throw new Error("motion sample message was not encoded");
    }
    expect(new TextDecoder().decode(message.bytes.slice(0, 4))).toBe("PMO1");
    expect(readMotionPermission("paseo-next-v2", "demo")).toBe("granted");

    cleanup();
  });

  it("persists denial and requires an explicit reset", async () => {
    const requestPermission = vi.fn(async () => "denied" as const);
    vi.stubGlobal("DeviceMotionEvent", motionConstructor(requestPermission));
    const { iframe, container, postMessage } = productFrame();
    const cleanup = setupMotion(
      "demo",
      "paseo-next-v2",
      iframe,
      container,
      new URL(iframe.src).origin,
    );
    const button = container.querySelector("button");

    button?.click();
    await vi.waitFor(() => {
      expect(button?.textContent).toBe("Motion blocked — reset");
    });
    expect(readMotionPermission("paseo-next-v2", "demo")).toBe("denied");
    expect(postMessage).toHaveBeenCalledWith(
      { type: "dotli:pvm-motion-status", availability: 2 },
      iframe.src.slice(0, -1),
    );

    button?.click();
    expect(button?.textContent).toBe("Enable motion");
    expect(
      localStorage.getItem(motionPermissionStorageKey("paseo-next-v2", "demo")),
    ).toBeNull();
    expect(requestPermission).toHaveBeenCalledOnce();
    cleanup();
  });

  it("does not show a control when the browser has no motion source", () => {
    vi.stubGlobal("DeviceMotionEvent", undefined);
    const { iframe, container, postMessage } = productFrame();
    const cleanup = setupMotion(
      "demo",
      "paseo-next-v2",
      iframe,
      container,
      new URL(iframe.src).origin,
    );

    expect(container.querySelector("button")).toBeNull();
    expect(postMessage).toHaveBeenCalledWith(
      { type: "dotli:pvm-motion-status", availability: 0 },
      iframe.src.slice(0, -1),
    );
    cleanup();
  });
});
