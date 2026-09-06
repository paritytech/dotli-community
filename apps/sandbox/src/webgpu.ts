// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

const GPU_READY_TIMEOUT_MS = 30_000;

export interface WebGpuRequirements {
  requiredFeatures: string[];
  requiredLimits: Record<string, number>;
}

interface Dimensions {
  physicalWidth: number;
  physicalHeight: number;
  logicalWidth: number;
  logicalHeight: number;
  scale: number;
}

interface Callbacks {
  event: (bytes: Uint8Array) => void;
  capabilities: (bytes: Uint8Array) => void;
  presented: () => void;
  error: (error: Error) => void;
}

function dimensions(canvas: HTMLCanvasElement): Dimensions {
  const bounds = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const logicalWidth = Math.max(1, Math.round(bounds.width));
  const logicalHeight = Math.max(1, Math.round(bounds.height));
  return {
    physicalWidth: Math.max(1, Math.round(logicalWidth * scale)),
    physicalHeight: Math.max(1, Math.round(logicalHeight * scale)),
    logicalWidth,
    logicalHeight,
    scale,
  };
}

export class WebGpuBridge {
  readonly #worker: Worker;
  readonly #resizeObserver: ResizeObserver;
  readonly capabilities: Promise<Uint8Array>;
  #stopped = false;
  #physicalWidth = 1;
  #physicalHeight = 1;

  constructor(
    canvas: HTMLCanvasElement,
    requirements: WebGpuRequirements,
    callbacks: Callbacks,
  ) {
    if (typeof canvas.transferControlToOffscreen !== "function") {
      throw new Error("WebGPU OffscreenCanvas is unavailable");
    }
    const worker = new Worker("/polkavm-runtime/polkavm-gpu-worker.js");
    const offscreen = canvas.transferControlToOffscreen();
    const { promise, resolve, reject } = Promise.withResolvers<Uint8Array>();
    const timer = window.setTimeout(() => {
      reject(new Error("WebGPU capability negotiation timed out"));
    }, GPU_READY_TIMEOUT_MS);
    this.#worker = worker;
    this.capabilities = promise;
    worker.onmessage = (event: MessageEvent<unknown>): void => {
      const message =
        event.data !== null && typeof event.data === "object"
          ? (event.data as Record<string, unknown>)
          : null;
      if (
        message?.type === "capabilities" &&
        message.bytes instanceof Uint8Array
      ) {
        const bytes = message.bytes.slice();
        const view = new DataView(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        );
        if (
          bytes.byteLength < 56 ||
          view.getUint32(0, true) !== 0x31434745 ||
          view.getUint16(4, true) !== 1 ||
          view.getUint32(8, true) !== bytes.byteLength
        ) {
          const error = new Error("Invalid WebGPU capability record");
          reject(error);
          callbacks.error(error);
          return;
        }
        this.#physicalWidth = view.getUint32(16, true);
        this.#physicalHeight = view.getUint32(20, true);
        window.clearTimeout(timer);
        canvas.dataset.polkavmGpu = "ready";
        callbacks.capabilities(bytes);
        resolve(bytes);
      } else if (
        message?.type === "event" &&
        message.bytes instanceof Uint8Array
      ) {
        callbacks.event(message.bytes);
      } else if (message?.type === "presented") {
        callbacks.presented();
      } else if (message?.type === "error") {
        const error = new Error(
          typeof message.message === "string"
            ? message.message
            : "WebGPU worker failed",
        );
        reject(error);
        callbacks.error(error);
      }
    };
    worker.onerror = (): void => {
      const error = new Error("WebGPU worker failed");
      reject(error);
      callbacks.error(error);
    };
    worker.postMessage(
      {
        type: "init",
        canvas: offscreen,
        requirements,
        dimensions: dimensions(canvas),
        testReadback: false,
        testDeviceLoss: false,
      },
      [offscreen],
    );
    this.#resizeObserver = new ResizeObserver(() => {
      if (!this.#stopped) {
        worker.postMessage({ type: "resize", dimensions: dimensions(canvas) });
      }
    });
    this.#resizeObserver.observe(canvas);
  }

  get physicalWidth(): number {
    return this.#physicalWidth;
  }

  get physicalHeight(): number {
    return this.#physicalHeight;
  }

  submit(bytes: Uint8Array): void {
    if (this.#stopped || bytes.byteLength === 0) {
      return;
    }
    this.#worker.postMessage({ type: "batch", bytes }, [bytes.buffer]);
  }

  dispose(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#resizeObserver.disconnect();
    this.#worker.postMessage({ type: "stop" });
    this.#worker.terminate();
  }
}
