// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import './bc-ur-polyfill.js';
import { createComponent, createSignal } from 'solid-js';
import { BrowserQRCodeReader, type IScannerControls } from '@zxing/browser';
import { URDecoder } from '@ngraveio/bc-ur';
import { CameraScanDialog, type CameraOption } from './components/entities/CameraScanDialog.js';
import { mountRoot } from './mount/root.js';

const MAX_INPUT_BYTES = 1024 * 1024;

export interface CameraUrInputRequest {
  mediaType: string;
  maxBytes: number;
}

export class CameraInputCancelledError extends Error {
  constructor() {
    super('camera input cancelled');
    this.name = 'CameraInputCancelledError';
  }
}

export class CameraInputPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CameraInputPermissionError';
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
      throw new Error('invalid camera-UR input request');
    }
    this.#mediaType = request.mediaType;
    this.#maxBytes = request.maxBytes;
    this.#decoder = new URDecoder(undefined, request.mediaType);
  }

  receive(text: string): { progress: number; bytes: Uint8Array | null } {
    this.#decoder.receivePart(text.trim().toLowerCase());
    const progress = Math.min(100, Math.round(this.#decoder.estimatedPercentComplete() * 100));
    if (!this.#decoder.isComplete()) {
      return { progress, bytes: null };
    }
    if (!this.#decoder.isSuccess()) {
      throw new Error(this.#decoder.resultError() || 'UR fountain reconstruction failed');
    }
    const value = this.#decoder.resultUR();
    if (value.type !== this.#mediaType) {
      throw new Error(`expected UR type ${this.#mediaType}, got ${value.type}`);
    }
    const bytes = new Uint8Array(value.cbor);
    if (!bytes.byteLength || bytes.byteLength > this.#maxBytes) {
      throw new Error('decoded UR exceeds the registered input bound');
    }
    return { progress: 100, bytes };
  }
}

function cameraError(error: unknown): Error {
  const name = error instanceof Error ? error.name : '';
  if (typeof navigator === 'undefined' || !('mediaDevices' in navigator)) {
    return new Error('this browser exposes no camera API');
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new CameraInputPermissionError('browser camera permission denied');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new Error('no usable camera found on this device');
  }
  if (name === 'NotReadableError') {
    return new Error('the camera is already in use');
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function scanCameraUr(label: string, request: CameraUrInputRequest, signal: AbortSignal): Promise<Uint8Array> {
  const decoder = new CameraUrDecoder(request);
  const reader = new BrowserQRCodeReader(undefined, {
    delayBetweenScanAttempts: 50,
    delayBetweenScanSuccess: 50,
  });

  const [progress, setProgress] = createSignal('Waiting for a QR frame…');
  const [cameraOptions, setCameraOptions] = createSignal<CameraOption[]>([]);
  const [selectedCamera, setSelectedCamera] = createSignal('');
  const [compactPicker, setCompactPicker] = createSignal(false);
  // The dialog hands over its preview element once Solid has created it.
  const preview = Promise.withResolvers<HTMLVideoElement>();
  let video: HTMLVideoElement | undefined;
  let onCancel: () => void = () => undefined;
  let onSelectCamera: (deviceId: string) => void = () => undefined;
  let onFlipCamera: () => void = () => undefined;

  const container = document.createElement('div');
  document.body.append(container);
  const disposeDialog = mountRoot(
    'camera-scan',
    container,
    () =>
      createComponent(CameraScanDialog, {
        title: `Scan ${request.mediaType}`,
        detail: `${label} requested decoded camera input. Point the camera at the UR QR stream.`,
        get progress() {
          return progress();
        },
        get cameras() {
          return cameraOptions();
        },
        get selectedCamera() {
          return selectedCamera();
        },
        get compactPicker() {
          return compactPicker();
        },
        video: el => {
          video = el;
          preview.resolve(el);
        },
        onSelectCamera: deviceId => {
          onSelectCamera(deviceId);
        },
        onFlipCamera: () => {
          onFlipCamera();
        },
        onCancel: () => {
          onCancel();
        },
      }),
    {
      removeContainer: true,
      // A dialog that failed to render cannot be answered: cancel the scan.
      onBroken: () => {
        onCancel();
      },
    },
  );
  let controls: IScannerControls | undefined;
  let cameraGeneration = 0;
  let availableCameras: MediaDeviceInfo[] = [];
  let activeCameraDeviceId: string | undefined;
  let settled = false;

  return new Promise<Uint8Array>((resolve, reject) => {
    const cleanup = (): void => {
      cameraGeneration += 1;
      signal.removeEventListener('abort', onAbort);
      controls?.stop();
      const stream = video?.srcObject;
      if (stream instanceof MediaStream) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
      }
      if (video !== undefined) {
        video.srcObject = null;
      }
      disposeDialog();
    };
    const finish = (outcome: { bytes: Uint8Array } | { error: Error }): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if ('bytes' in outcome) {
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
        setProgress(`UR reconstruction ${String(decoded.progress)}%`);
        if (decoded.bytes !== null) {
          finish({ bytes: decoded.bytes });
        }
      } catch (error) {
        finish({ error: cameraError(error) });
      }
    };
    const populateCameraPicker = async (activeDeviceId: string | undefined): Promise<void> => {
      availableCameras = (await navigator.mediaDevices.enumerateDevices()).filter(
        device => device.kind === 'videoinput',
      );
      if (settled || availableCameras.length <= 1) {
        setCameraOptions([]);
        return;
      }
      setCompactPicker(window.matchMedia('(pointer: coarse)').matches);
      setCameraOptions(
        availableCameras.map((camera, index) => ({
          deviceId: camera.deviceId,
          label: camera.label.length > 0 ? camera.label : `Camera ${String(index + 1)}`,
        })),
      );
      setSelectedCamera(
        activeDeviceId !== undefined &&
          activeDeviceId.length > 0 &&
          availableCameras.some(camera => camera.deviceId === activeDeviceId)
          ? activeDeviceId
          : '',
      );
    };
    const startCamera = async (deviceId?: string): Promise<void> => {
      const generation = ++cameraGeneration;
      controls?.stop();
      controls = undefined;
      const videoConstraints: MediaTrackConstraints = {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
        ...(deviceId !== undefined && deviceId.length > 0
          ? { deviceId: { exact: deviceId } }
          : { facingMode: { ideal: 'environment' } }),
      };
      try {
        const element = await preview.promise;
        const nextControls = await reader.decodeFromConstraints({ video: videoConstraints }, element, receive);
        if (settled || generation !== cameraGeneration) {
          nextControls.stop();
          return;
        }
        controls = nextControls;
        const stream = element.srcObject;
        if (stream instanceof MediaStream) {
          const track = stream.getVideoTracks().at(0);
          const settingsDeviceId = track?.getSettings().deviceId;
          activeCameraDeviceId =
            settingsDeviceId !== undefined && settingsDeviceId.length > 0 ? settingsDeviceId : deviceId;
          const focusModes =
            track === undefined
              ? undefined
              : (
                  track.getCapabilities() as MediaTrackCapabilities & {
                    focusMode?: string[];
                  }
                ).focusMode;
          if (track !== undefined && focusModes?.includes('continuous') === true) {
            await track
              .applyConstraints({
                advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet],
              })
              .catch(() => undefined);
          }
        }
        await populateCameraPicker(activeCameraDeviceId).catch(() => {
          setCameraOptions([]);
        });
      } catch (error) {
        if (settled || generation !== cameraGeneration) {
          return;
        }
        throw error;
      }
    };
    onSelectCamera = deviceId => {
      setProgress('Switching camera…');
      void startCamera(deviceId.length > 0 ? deviceId : undefined).catch((error: unknown) => {
        finish({ error: cameraError(error) });
      });
    };
    onFlipCamera = () => {
      const activeIndex = availableCameras.findIndex(camera => camera.deviceId === activeCameraDeviceId);
      const nextCamera = availableCameras.at((activeIndex + 1) % availableCameras.length);
      if (nextCamera === undefined) {
        return;
      }
      setProgress('Switching camera…');
      void startCamera(nextCamera.deviceId).catch((error: unknown) => {
        finish({ error: cameraError(error) });
      });
    };
    onCancel = onAbort;

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    void startCamera().catch((error: unknown) => {
      finish({ error: cameraError(error) });
    });
  });
}
