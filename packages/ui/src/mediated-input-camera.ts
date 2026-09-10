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
  const progress = document.createElement("p");
  progress.textContent = "Waiting for a QR frame…";
  const footer = document.createElement("div");
  footer.className = "signing-modal-footer";
  const cancel = document.createElement("button");
  cancel.className = "signing-btn-cancel";
  cancel.textContent = "Cancel";
  footer.append(cancel);
  modal.append(heading, detail, video, progress, footer);
  backdrop.append(modal);
  document.body.append(backdrop);

  const constraints: MediaStreamConstraints = {
    video: { facingMode: { ideal: "environment" } },
  };
  let controls: IScannerControls | undefined;
  let settled = false;

  return new Promise<Uint8Array>((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
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
    signal.addEventListener("abort", onAbort, { once: true });
    cancel.addEventListener("click", onAbort, { once: true });
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        onAbort();
      }
    });
    if (signal.aborted) {
      onAbort();
      return;
    }

    void reader
      .decodeFromConstraints(constraints, video, (result) => {
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
      })
      .then((value) => {
        controls = value;
        if (settled) {
          controls.stop();
        }
      })
      .catch((error: unknown) => {
        finish({ error: cameraError(error) });
      });
  });
}
