// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import "./bc-ur-polyfill";
import { BrowserQRCodeReader, type IScannerControls } from "@zxing/browser";
import { URDecoder } from "@ngraveio/bc-ur";

const MAX_INPUT_BYTES = 1024 * 1024;

export interface CameraUrInputRequest {
  mediaType: string;
  maxBytes: number;
}

export class CameraInputCancelledError extends Error {
  constructor() {
    super("camera input cancelled");
    this.name = "CameraInputCancelledError";
  }
}

export class CameraInputPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CameraInputPermissionError";
  }
}

export class CameraUrDecoder {
  readonly #decoder: URDecoder;
  readonly #mediaType: string;
  readonly #maxBytes: number;

  constructor(request: CameraUrInputRequest) {
    if (
      !/^[a-z0-9][a-z0-9+._-]*[a-z0-9]$|^[a-z0-9]$/.test(request.mediaType) ||
      !Number.isInteger(request.maxBytes) ||
      request.maxBytes < 1 ||
      request.maxBytes > MAX_INPUT_BYTES
    ) {
      throw new Error("invalid camera-UR input request");
    }
    this.#mediaType = request.mediaType;
    this.#maxBytes = request.maxBytes;
    this.#decoder = new URDecoder(undefined, request.mediaType);
  }

  receive(text: string): { progress: number; bytes: Uint8Array | null } {
    this.#decoder.receivePart(text.trim().toLowerCase());
    const progress = Math.min(
      100,
      Math.round(this.#decoder.estimatedPercentComplete() * 100),
    );
    if (!this.#decoder.isComplete()) {
      return { progress, bytes: null };
    }
    if (!this.#decoder.isSuccess()) {
      throw new Error(
        this.#decoder.resultError() || "UR fountain reconstruction failed",
      );
    }
    const value = this.#decoder.resultUR();
    if (value.type !== this.#mediaType) {
      throw new Error(`expected UR type ${this.#mediaType}, got ${value.type}`);
    }
    const bytes = new Uint8Array(value.cbor);
    if (!bytes.byteLength || bytes.byteLength > this.#maxBytes) {
      throw new Error("decoded UR exceeds the registered input bound");
    }
    return { progress: 100, bytes };
  }
}

function cameraError(error: unknown): Error {
  const name = error instanceof Error ? error.name : "";
  if (typeof navigator === "undefined" || !("mediaDevices" in navigator)) {
    return new Error("this browser exposes no camera API");
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new CameraInputPermissionError("browser camera permission denied");
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return new Error("no usable camera found on this device");
  }
  if (name === "NotReadableError") {
    return new Error("the camera is already in use");
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function scanCameraUr(
  label: string,
  request: CameraUrInputRequest,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const decoder = new CameraUrDecoder(request);
  const reader = new BrowserQRCodeReader(undefined, {
    delayBetweenScanAttempts: 50,
    delayBetweenScanSuccess: 50,
  });

  const backdrop = document.createElement("div");
  backdrop.className = "signing-modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "signing-modal";
  modal.style.width = "min(680px, calc(100vw - 32px))";

  const heading = document.createElement("h2");
  heading.textContent = `Scan ${request.mediaType}`;
  const detail = document.createElement("p");
  detail.textContent = `${label} requested decoded camera input. Point the camera at the UR QR stream.`;
  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.style.cssText =
    "display:block;width:100%;max-height:60vh;object-fit:cover;background:#050505;border-radius:10px;margin:16px 0";
  const cameraPicker = document.createElement("div");
  cameraPicker.className = "camera-input-picker";
  cameraPicker.hidden = true;
  const cameraPickerLabel = document.createElement("span");
  cameraPickerLabel.textContent = "Camera";
  const cameraSelect = document.createElement("select");
  cameraSelect.setAttribute("aria-label", "Camera");
  const cameraFlip = document.createElement("button");
  cameraFlip.type = "button";
  cameraFlip.className = "signing-btn-cancel";
  cameraFlip.textContent = "Flip camera";
  cameraFlip.hidden = true;
  cameraPicker.append(cameraPickerLabel, cameraSelect, cameraFlip);
  const progress = document.createElement("p");
  progress.textContent = "Waiting for a QR frame…";
  const footer = document.createElement("div");
  footer.className = "signing-modal-footer";
  const cancel = document.createElement("button");
  cancel.className = "signing-btn-cancel";
  cancel.textContent = "Cancel";
  footer.append(cancel);
  modal.append(heading, detail, video, cameraPicker, progress, footer);
  backdrop.append(modal);
  document.body.append(backdrop);

  let controls: IScannerControls | undefined;
  let cameraGeneration = 0;
  let availableCameras: MediaDeviceInfo[] = [];
  let activeCameraDeviceId: string | undefined;
  let settled = false;

  return new Promise<Uint8Array>((resolve, reject) => {
    const cleanup = (): void => {
      cameraGeneration += 1;
      signal.removeEventListener("abort", onAbort);
      cameraSelect.removeEventListener("change", onCameraChange);
      cameraFlip.removeEventListener("click", onFlipCamera);
      controls?.stop();
      const stream = video.srcObject;
      if (stream instanceof MediaStream) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
      }
      video.srcObject = null;
      backdrop.remove();
    };
    const finish = (
      outcome: { bytes: Uint8Array } | { error: Error },
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if ("bytes" in outcome) {
        resolve(outcome.bytes);
      } else {
        reject(outcome.error);
      }
    };
    const onAbort = (): void => {
      finish({ error: new CameraInputCancelledError() });
    };
    const receive = (result: { getText(): string } | undefined): void => {
      if (!result || settled) {
        return;
      }
      try {
        const decoded = decoder.receive(result.getText());
        progress.textContent = `UR reconstruction ${String(decoded.progress)}%`;
        if (decoded.bytes !== null) {
          finish({ bytes: decoded.bytes });
        }
      } catch (error) {
        finish({ error: cameraError(error) });
      }
    };
    const populateCameraPicker = async (
      activeDeviceId: string | undefined,
    ): Promise<void> => {
      if (!navigator.mediaDevices.enumerateDevices) {
        return;
      }
      availableCameras = (await navigator.mediaDevices.enumerateDevices()).filter(
        (device) => device.kind === "videoinput",
      );
      if (settled || availableCameras.length <= 1) {
        cameraPicker.hidden = true;
        return;
      }
      const compactControl = window.matchMedia("(pointer: coarse)").matches;
      cameraSelect.hidden = compactControl;
      cameraFlip.hidden = !compactControl;
      cameraSelect.replaceChildren(new Option("System default camera", ""));
      availableCameras.forEach((camera, index) => {
        cameraSelect.add(
          new Option(camera.label || `Camera ${String(index + 1)}`, camera.deviceId),
        );
      });
      cameraSelect.value =
        activeDeviceId &&
        availableCameras.some((camera) => camera.deviceId === activeDeviceId)
          ? activeDeviceId
          : "";
      cameraPicker.hidden = false;
    };
    const startCamera = async (deviceId?: string): Promise<void> => {
      const generation = ++cameraGeneration;
      controls?.stop();
      controls = undefined;
      const videoConstraints: MediaTrackConstraints = {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
        ...(deviceId
          ? { deviceId: { exact: deviceId } }
          : { facingMode: { ideal: "environment" } }),
      };
      try {
        const nextControls = await reader.decodeFromConstraints(
          { video: videoConstraints },
          video,
          receive,
        );
        if (settled || generation !== cameraGeneration) {
          nextControls.stop();
          return;
        }
        controls = nextControls;
        const stream = video.srcObject;
        if (stream instanceof MediaStream) {
          const [track] = stream.getVideoTracks();
          activeCameraDeviceId = track?.getSettings().deviceId || deviceId;
          const focusModes = (
            track?.getCapabilities() as
              | (MediaTrackCapabilities & { focusMode?: string[] })
              | undefined
          )?.focusMode;
          if (track && focusModes?.includes("continuous")) {
            await track
              .applyConstraints({
                advanced: [
                  { focusMode: "continuous" } as MediaTrackConstraintSet,
                ],
              })
              .catch(() => undefined);
          }
        }
        await populateCameraPicker(activeCameraDeviceId).catch(() => {
          cameraPicker.hidden = true;
        });
      } catch (error) {
        if (settled || generation !== cameraGeneration) {
          return;
        }
        throw error;
      }
    };
    const onCameraChange = (): void => {
      progress.textContent = "Switching camera…";
      void startCamera(cameraSelect.value || undefined).catch((error) => {
        finish({ error: cameraError(error) });
      });
    };
    const onFlipCamera = (): void => {
      const activeIndex = availableCameras.findIndex(
        (camera) => camera.deviceId === activeCameraDeviceId,
      );
      const nextCamera = availableCameras[(activeIndex + 1) % availableCameras.length];
      if (!nextCamera) {
        return;
      }
      progress.textContent = "Switching camera…";
      void startCamera(nextCamera.deviceId).catch((error) => {
        finish({ error: cameraError(error) });
      });
    };

    signal.addEventListener("abort", onAbort, { once: true });
    cancel.addEventListener("click", onAbort, { once: true });
    cameraSelect.addEventListener("change", onCameraChange);
    cameraFlip.addEventListener("click", onFlipCamera);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        onAbort();
      }
    });
    if (signal.aborted) {
      onAbort();
      return;
    }

    void startCamera().catch((error: unknown) => {
      finish({ error: cameraError(error) });
    });
  });
}
