// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

const MOTION_SAMPLE_BYTES = 48;
const MOTION_FLAG_ACCELERATION = 1;
const MOTION_FLAG_ROTATION = 2;
const MOTION_PERMISSION_PREFIX = "dotli:motion:";
const MOTION_SAMPLE_INTERVAL_MS = 1000 / 60;
const MOTION_EVENT_TIMEOUT_MS = 1500;
const noop = (): void => undefined;

export type MotionPermission = "ask" | "granted" | "denied";
type BrowserMotionPermission = "granted" | "denied";
interface PermissionRequestingConstructor {
  requestPermission?: () => Promise<BrowserMotionPermission>;
}

export interface MotionSample {
  flags: number;
  sequence: number;
  timestampMs: number;
  accelerationX: number;
  accelerationY: number;
  accelerationZ: number;
  rotationAlpha: number;
  rotationBeta: number;
  rotationGamma: number;
}

function finiteTriple(
  x: number | null,
  y: number | null,
  z: number | null,
): boolean {
  return (
    x !== null &&
    y !== null &&
    z !== null &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(z)
  );
}

export function encodeMotionSample(sample: MotionSample): Uint8Array {
  if (
    !Number.isInteger(sample.flags) ||
    sample.flags <= 0 ||
    sample.flags & ~(MOTION_FLAG_ACCELERATION | MOTION_FLAG_ROTATION) ||
    !Number.isSafeInteger(sample.sequence) ||
    sample.sequence <= 0 ||
    sample.sequence > 0xffffffff ||
    !Number.isFinite(sample.timestampMs) ||
    sample.timestampMs < 0 ||
    [
      sample.accelerationX,
      sample.accelerationY,
      sample.accelerationZ,
      sample.rotationAlpha,
      sample.rotationBeta,
      sample.rotationGamma,
    ].some((value) => !Number.isFinite(value))
  ) {
    throw new Error("invalid MotionSample v1");
  }
  const bytes = new Uint8Array(MOTION_SAMPLE_BYTES);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("PMO1"));
  view.setUint16(4, 1, true);
  view.setUint16(6, sample.flags, true);
  view.setUint32(8, MOTION_SAMPLE_BYTES, true);
  view.setUint32(12, sample.sequence, true);
  view.setFloat64(16, sample.timestampMs, true);
  view.setFloat32(24, sample.accelerationX, true);
  view.setFloat32(28, sample.accelerationY, true);
  view.setFloat32(32, sample.accelerationZ, true);
  view.setFloat32(36, sample.rotationAlpha, true);
  view.setFloat32(40, sample.rotationBeta, true);
  view.setFloat32(44, sample.rotationGamma, true);
  return bytes;
}

export function motionPermissionStorageKey(
  network: string,
  label: string,
): string {
  return `${MOTION_PERMISSION_PREFIX}${network}:${label}`;
}

export function readMotionPermission(
  network: string,
  label: string,
): MotionPermission {
  try {
    const value = localStorage.getItem(
      motionPermissionStorageKey(network, label),
    );
    return value === "granted" || value === "denied" ? value : "ask";
  } catch {
    return "ask";
  }
}

function persistMotionPermission(
  network: string,
  label: string,
  permission: Exclude<MotionPermission, "ask">,
): void {
  try {
    localStorage.setItem(
      motionPermissionStorageKey(network, label),
      permission,
    );
    // eslint-disable-next-line no-restricted-syntax -- localStorage can be unavailable in Safari private mode; the browser permission remains authoritative.
  } catch {
    /* product permission persistence unavailable */
  }
}

function resetMotionPermission(network: string, label: string): void {
  try {
    localStorage.removeItem(motionPermissionStorageKey(network, label));
    // eslint-disable-next-line no-restricted-syntax -- localStorage can be unavailable in Safari private mode.
  } catch {
    /* product permission persistence unavailable */
  }
}

export function browserMotionSourceAvailable(): boolean {
  return typeof window.DeviceMotionEvent === "function";
}

async function requestBrowserMotionPermission(): Promise<boolean> {
  const constructor = window.DeviceMotionEvent as unknown as
    | PermissionRequestingConstructor
    | undefined;
  return typeof constructor?.requestPermission === "function"
    ? (await constructor.requestPermission()) === "granted"
    : true;
}

/**
 * Install an inert host-owned motion control for one motion-capable PVM
 * product. Sensors start only after a direct user click and stop whenever the
 * product is hidden or disposed.
 */
export function setupMotion(
  label: string,
  network: string,
  iframe: HTMLIFrameElement,
  container: HTMLElement,
  targetOrigin: string,
): () => void {
  const sendStatus = (availability: 0 | 1 | 2): void => {
    iframe.contentWindow?.postMessage(
      { type: "dotli:pvm-motion-status", availability },
      targetOrigin,
    );
  };
  sendStatus(0);
  if (!browserMotionSourceAvailable()) {
    return noop;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", "Enable motion controls for this product");
  button.style.cssText =
    "position:fixed;right:max(12px,env(safe-area-inset-right));bottom:max(12px,env(safe-area-inset-bottom));z-index:2147483000;padding:9px 13px;border:1px solid #ffffff4d;border-radius:999px;background:#111d;color:#fff;font:600 13px system-ui;backdrop-filter:blur(10px);";
  container.appendChild(button);

  let permission = readMotionPermission(network, label);
  let active = false;
  let disposed = false;
  let sequence = 0;
  let lastSampleAt = Number.NEGATIVE_INFINITY;
  let eventTimeout: number | null = null;

  const updateButton = (): void => {
    if (active) {
      button.textContent = "Motion active";
    } else if (permission === "denied") {
      button.textContent = "Motion blocked — reset";
    } else {
      button.textContent = "Enable motion";
    }
  };
  updateButton();

  const stopMotion = (): void => {
    active = false;
    if (eventTimeout !== null) {
      clearTimeout(eventTimeout);
      eventTimeout = null;
    }
    window.removeEventListener("devicemotion", onMotion);
    sendStatus(0);
    updateButton();
  };

  const sendSample = (sample: MotionSample): void => {
    const bytes = encodeMotionSample(sample);
    const buffer = bytes.buffer;
    iframe.contentWindow?.postMessage(
      { type: "dotli:pvm-motion-sample", bytes: buffer },
      targetOrigin,
      [buffer],
    );
  };

  const onMotion = (event: DeviceMotionEvent): void => {
    if (!active || document.visibilityState !== "visible") {
      return;
    }
    const timestampMs = Number.isFinite(event.timeStamp)
      ? event.timeStamp
      : performance.now();
    if (timestampMs - lastSampleAt < MOTION_SAMPLE_INTERVAL_MS) {
      return;
    }

    const acceleration = event.accelerationIncludingGravity;
    const rotation = event.rotationRate;
    const hasAcceleration = finiteTriple(
      acceleration?.x ?? null,
      acceleration?.y ?? null,
      acceleration?.z ?? null,
    );
    const hasRotation = finiteTriple(
      rotation?.alpha ?? null,
      rotation?.beta ?? null,
      rotation?.gamma ?? null,
    );
    const flags =
      (hasAcceleration ? MOTION_FLAG_ACCELERATION : 0) |
      (hasRotation ? MOTION_FLAG_ROTATION : 0);
    if (flags === 0) {
      return;
    }

    if (eventTimeout !== null) {
      clearTimeout(eventTimeout);
      eventTimeout = null;
    }
    lastSampleAt = timestampMs;
    sequence = sequence === 0xffffffff ? 1 : sequence + 1;
    sendSample({
      flags,
      sequence,
      timestampMs: Math.max(0, timestampMs),
      accelerationX: hasAcceleration ? (acceleration?.x ?? 0) : 0,
      accelerationY: hasAcceleration ? (acceleration?.y ?? 0) : 0,
      accelerationZ: hasAcceleration ? (acceleration?.z ?? 0) : 0,
      rotationAlpha: hasRotation ? (rotation?.alpha ?? 0) : 0,
      rotationBeta: hasRotation ? (rotation?.beta ?? 0) : 0,
      rotationGamma: hasRotation ? (rotation?.gamma ?? 0) : 0,
    });
  };

  const onVisibilityChange = (): void => {
    if (document.visibilityState !== "visible" && active) {
      stopMotion();
    }
  };

  button.addEventListener("click", () => {
    if (permission === "denied") {
      resetMotionPermission(network, label);
      permission = "ask";
      sendStatus(0);
      updateButton();
      return;
    }
    if (active) {
      return;
    }

    button.disabled = true;
    button.textContent = "Requesting motion…";
    void requestBrowserMotionPermission().then((granted) => {
      if (disposed) {
        return;
      }
      button.disabled = false;
      if (!granted) {
        permission = "denied";
        persistMotionPermission(network, label, permission);
        sendStatus(2);
        updateButton();
        return;
      }

      permission = "granted";
      persistMotionPermission(network, label, permission);
      active = true;
      sendStatus(1);
      updateButton();
      window.addEventListener("devicemotion", onMotion);
      document.addEventListener("visibilitychange", onVisibilityChange);
      eventTimeout = window.setTimeout(() => {
        if (!disposed && active) {
          stopMotion();
          button.textContent = "Motion unavailable";
        }
      }, MOTION_EVENT_TIMEOUT_MS);
    });
  });

  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    disposed = true;
    stopMotion();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    button.remove();
  };
}
