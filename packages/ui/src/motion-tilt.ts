// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

const MOTION_TILT_BYTES = 40;
const MOTION_TILT_RANGE_DEGREES = 24;
const MOTION_TILT_SMOOTHING = 0.18;
const MOTION_PERMISSION_PREFIX = "dotli:motion-tilt:";

type MotionPermission = "granted" | "denied";
type PermissionRequestingConstructor = {
  requestPermission?: () => Promise<MotionPermission>;
};

interface MotionTiltState {
  sequence: number;
  baselineBeta: number | null;
  baselineGamma: number | null;
  targetX: number;
  targetY: number;
  tiltX: number;
  tiltY: number;
  azimuth: number | null;
  animationFrame: number | null;
}

export interface MotionTiltSample {
  sequence: number;
  timestampUs: bigint;
  tiltX: number;
  tiltY: number;
  azimuth: number | null;
}

export function manifestRequestsMotionTilt(
  manifestText: string | null,
): boolean {
  if (manifestText === null) return false;
  try {
    const manifest = JSON.parse(manifestText) as {
      $v?: unknown;
      kind?: unknown;
      capabilities?: {
        deviceInput?: { abiVersion?: unknown; optionalFeatures?: unknown };
      };
    };
    const input = manifest.capabilities?.deviceInput;
    return (
      manifest.$v === 2 &&
      manifest.kind === "app" &&
      input?.abiVersion === 1 &&
      Array.isArray(input.optionalFeatures) &&
      input.optionalFeatures.includes("motion-tilt")
    );
  } catch {
    return false;
  }
}

export function encodeMotionTiltSample(sample: MotionTiltSample): Uint8Array {
  if (
    !Number.isSafeInteger(sample.sequence) ||
    sample.sequence <= 0 ||
    sample.sequence > 0xffffffff ||
    sample.timestampUs < 0n ||
    sample.timestampUs > 0xffffffffffffffffn ||
    !Number.isFinite(sample.tiltX) ||
    sample.tiltX < -1 ||
    sample.tiltX > 1 ||
    !Number.isFinite(sample.tiltY) ||
    sample.tiltY < -1 ||
    sample.tiltY > 1 ||
    (sample.azimuth !== null && !Number.isFinite(sample.azimuth))
  ) {
    throw new Error("invalid motion-tilt sample");
  }
  const bytes = new Uint8Array(MOTION_TILT_BYTES);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("PMT1"));
  view.setUint16(4, 1, true);
  view.setUint16(6, 1 | (sample.azimuth === null ? 0 : 2), true);
  view.setUint32(8, MOTION_TILT_BYTES, true);
  view.setUint32(12, sample.sequence, true);
  view.setBigUint64(16, sample.timestampUs, true);
  view.setFloat32(24, sample.tiltX, true);
  view.setFloat32(28, sample.tiltY, true);
  view.setFloat32(32, sample.azimuth ?? 0, true);
  return bytes;
}

function wrapDegrees(value: number): number {
  return ((((value + 180) % 360) + 360) % 360) - 180;
}

function screenAngle(): number {
  const angle = window.screen.orientation?.angle;
  if (typeof angle === "number") return angle;
  const legacy = (window as Window & { orientation?: unknown }).orientation;
  return typeof legacy === "number" ? legacy : 0;
}

async function requestBrowserMotionPermission(): Promise<boolean> {
  const requests: Promise<MotionPermission>[] = [];
  for (const constructor of [
    window.DeviceMotionEvent,
    window.DeviceOrientationEvent,
  ]) {
    const permissionConstructor = constructor as unknown as
      | PermissionRequestingConstructor
      | undefined;
    if (typeof permissionConstructor?.requestPermission === "function") {
      // Invoke every browser prompt before the first await so Safari sees the
      // original button activation for both permission requests.
      requests.push(permissionConstructor.requestPermission());
    }
  }
  const results = await Promise.all(requests);
  return results.every((result) => result === "granted");
}

function persistPermission(label: string, permission: MotionPermission): void {
  try {
    localStorage.setItem(`${MOTION_PERMISSION_PREFIX}${label}`, permission);
    // eslint-disable-next-line no-restricted-syntax -- localStorage can be unavailable in Safari private mode; the browser permission remains authoritative.
  } catch {
    /* product permission persistence unavailable */
  }
}

/**
 * Install a host-owned, product-scoped motion permission control and forward
 * calibrated latest-state samples to one sandbox iframe.
 */
export function setupMotionTilt(
  label: string,
  iframe: HTMLIFrameElement,
  container: HTMLElement,
): () => void {
  if (!("DeviceOrientationEvent" in window)) return () => {};

  const state: MotionTiltState = {
    sequence: 0,
    baselineBeta: null,
    baselineGamma: null,
    targetX: 0,
    targetY: 0,
    tiltX: 0,
    tiltY: 0,
    azimuth: null,
    animationFrame: null,
  };
  const targetOrigin = new URL(iframe.src).origin;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Enable motion";
  button.setAttribute("aria-label", "Enable motion controls for this product");
  button.style.cssText =
    "position:fixed;right:max(12px,env(safe-area-inset-right));bottom:max(12px,env(safe-area-inset-bottom));z-index:2147483000;padding:9px 13px;border:1px solid #ffffff4d;border-radius:999px;background:#111d;color:#fff;font:600 13px system-ui;backdrop-filter:blur(10px);";
  container.appendChild(button);

  let active = false;
  let disposed = false;

  const sendClear = (): void => {
    iframe.contentWindow?.postMessage(
      { type: "dotli:pvm-motion-clear" },
      targetOrigin,
    );
  };
  const sendSample = (): void => {
    state.animationFrame = null;
    if (!active || document.visibilityState !== "visible") return;
    state.tiltX += (state.targetX - state.tiltX) * MOTION_TILT_SMOOTHING;
    state.tiltY += (state.targetY - state.tiltY) * MOTION_TILT_SMOOTHING;
    state.sequence = state.sequence === 0xffffffff ? 1 : state.sequence + 1;
    const bytes = encodeMotionTiltSample({
      sequence: state.sequence,
      timestampUs: BigInt(Math.max(0, Math.trunc(performance.now() * 1000))),
      tiltX: state.tiltX,
      tiltY: state.tiltY,
      azimuth: state.azimuth,
    });
    const buffer = bytes.buffer;
    iframe.contentWindow?.postMessage(
      { type: "dotli:pvm-motion-tilt", bytes: buffer },
      targetOrigin,
      [buffer],
    );
  };
  const onOrientation = (event: DeviceOrientationEvent): void => {
    if (!active || event.beta === null || event.gamma === null) return;
    state.baselineBeta ??= event.beta;
    state.baselineGamma ??= event.gamma;
    const beta = wrapDegrees(event.beta - state.baselineBeta);
    const gamma = wrapDegrees(event.gamma - state.baselineGamma);
    const radians = (screenAngle() * Math.PI) / 180;
    const horizontal = gamma * Math.cos(radians) + beta * Math.sin(radians);
    const vertical = -gamma * Math.sin(radians) + beta * Math.cos(radians);
    state.targetX = Math.max(
      -1,
      Math.min(1, -horizontal / MOTION_TILT_RANGE_DEGREES),
    );
    state.targetY = Math.max(
      -1,
      Math.min(1, vertical / MOTION_TILT_RANGE_DEGREES),
    );
    state.azimuth = event.alpha === null ? null : (event.alpha * Math.PI) / 180;
    state.animationFrame ??= requestAnimationFrame(sendSample);
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState !== "visible") {
      state.baselineBeta = null;
      state.baselineGamma = null;
      sendClear();
    }
  };

  button.addEventListener("click", () => {
    if (active) {
      state.baselineBeta = null;
      state.baselineGamma = null;
      button.textContent = "Motion active";
      return;
    }
    button.disabled = true;
    button.textContent = "Requesting motion…";
    void requestBrowserMotionPermission().then((granted) => {
      if (disposed) return;
      button.disabled = false;
      if (!granted) {
        persistPermission(label, "denied");
        button.textContent = "Motion denied — retry";
        sendClear();
        return;
      }
      persistPermission(label, "granted");
      active = true;
      button.textContent = "Motion active";
      window.addEventListener("deviceorientation", onOrientation);
      document.addEventListener("visibilitychange", onVisibilityChange);
    });
  });

  return () => {
    disposed = true;
    active = false;
    if (state.animationFrame !== null)
      cancelAnimationFrame(state.animationFrame);
    window.removeEventListener("deviceorientation", onOrientation);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    sendClear();
    button.remove();
  };
}
