// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ArchiveFiles } from "@dotli/content/archive";
import { Tri2dRenderer } from "./tri2d-renderer";
import { WebGpuRasterBridge, type WebGpuRequirements } from "./webgpu-raster";

const PVM_RUNTIME_ROOT = "/pvm-runtime";
const MAX_PROGRAM_BYTES = 16 * 1024 * 1024;
const MAX_ASSET_FILES = 2_048;
const MAX_ASSET_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ASSET_BYTES = 128 * 1024 * 1024;
const MAX_AUDIO_BYTES = 48_000 * 2 * 2;
const MAX_SAVE_BYTES = 1024 * 1024;
const MAX_TRANSLATED_WASM_BYTES = 16 * 1024 * 1024;
const MAX_TRUAPI_FRAME_BYTES = 1024 * 1024;
const MAX_TRUAPI_PENDING_FRAMES = 32;
const MAX_TRUAPI_PENDING_BYTES = 4 * 1024 * 1024;
const TRUAPI_PORT_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 30_000;
const INTERPRETER_START_TIMEOUT_MS = 180_000;
const SAVE_DB_NAME = "dotli-pvm";
const SAVE_DB_VERSION = 2;
const SAVE_STORE = "saves";
const TRANSLATION_STORE = "translations";
const RUNTIME_SOURCE = "epoca-554d993b-pvm-wasm-v6";
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const compiledModules = new Map<string, WebAssembly.Module>();
let runtimeBytesPromise: Promise<ArrayBuffer> | null = null;

export interface PvmMetrics {
  backend: "compiler" | "interpreter" | "starting";
  cacheHit: boolean;
  translationMs: number;
  compilationMs: number;
  startupMs: number;
  startupStage: string;
  firstFrameMs: number;
  translatedWasmBytes: number;
  frames: number;
  fps: number;
  updates: number;
  updateP50Ms: number;
  updateP95Ms: number;
  updateMaxMs: number;
  audioChunks: number;
  audioSamples: number;
}

declare global {
  interface Window {
    __dotliPvmMetrics?: PvmMetrics;
    __HOST_API_PORT__?: MessagePort;
  }
}

interface PvmDescriptor {
  programPath: string;
  graphicsProfile: "framebuffer" | "tri2d" | "webgpu-raster";
  webGpuRequirements: WebGpuRequirements | null;
  controls: string[];
  audioEnabled: boolean;
  requiredAssets: string[];
  manifestVersion: number | null;
}

interface WorkerReady {
  type: "ready";
  backend: "compiler" | "interpreter";
  cacheHit?: boolean;
  translationMs?: number;
  compilationMs?: number;
  startupMs?: number;
  translatedWasmBytes?: number;
  usesMotion: boolean;
}

interface WorkerStartup {
  type: "startup";
  stage: string;
}

interface WorkerFrame {
  type: "frame";
  width: number;
  height: number;
  pixels: Uint8Array;
}

interface WorkerTri2d {
  type: "tri2d";
  bytes: Uint8Array;
}

interface WorkerGpuBatch {
  type: "gpu-batch";
  bytes: Uint8Array;
}
interface WorkerAudio {
  type: "audio";
  sampleRate: number;
  channels: number;
  samples: Uint8Array;
}

interface WorkerMetrics {
  type: "metrics";
  updates: number;
  updateP50Ms: number;
  updateP95Ms: number;
  updateMaxMs: number;
}

const keyCodes: Readonly<Record<string, number>> = Object.freeze({
  KeyA: 0x04,
  KeyB: 0x05,
  KeyC: 0x06,
  KeyD: 0x07,
  KeyE: 0x08,
  KeyF: 0x09,
  KeyG: 0x0a,
  KeyH: 0x0b,
  KeyI: 0x0c,
  KeyJ: 0x0d,
  KeyK: 0x0e,
  KeyL: 0x0f,
  KeyM: 0x10,
  KeyN: 0x11,
  KeyO: 0x12,
  KeyP: 0x13,
  KeyQ: 0x14,
  KeyR: 0x15,
  KeyS: 0x16,
  KeyT: 0x17,
  KeyU: 0x18,
  KeyV: 0x19,
  KeyW: 0x1a,
  KeyX: 0x1b,
  KeyY: 0x1c,
  KeyZ: 0x1d,
  Digit1: 0x1e,
  Digit2: 0x1f,
  Digit3: 0x20,
  Digit4: 0x21,
  Digit5: 0x22,
  Digit6: 0x23,
  Digit7: 0x24,
  Digit8: 0x25,
  Digit9: 0x26,
  Digit0: 0x27,
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  Minus: 0x2d,
  Equal: 0x2e,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
  ControlLeft: 0xe0,
  ShiftLeft: 0xe1,
  AltLeft: 0xe2,
  ControlRight: 0xe4,
  ShiftRight: 0xe5,
  AltRight: 0xe6,
});
const pointerButtons: Readonly<Record<number, number>> = Object.freeze({
  0: 1,
  1: 3,
  2: 2,
});

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanPath(value: unknown): string | null {
  if (typeof value !== "string" || value === "" || value.includes("\\")) {
    return null;
  }
  const path = value.replace(/^\/+/, "");
  const parts = path.split("/");
  return parts.some((part) => part === "" || part === "." || part === "..")
    ? null
    : path;
}

function assertExternalManifest(
  embedded: Uint8Array,
  externalManifest: string | null,
): void {
  if (externalManifest === null) {
    throw new Error("external App manifest is required for App manifest v2");
  }
  const external = encoder.encode(externalManifest);
  if (
    external.byteLength !== embedded.byteLength ||
    external.some((byte, index) => byte !== embedded[index])
  ) {
    throw new Error(
      "embedded App manifest does not match the external executable record",
    );
  }
}

function parseManifest(
  files: ArchiveFiles,
  externalManifest: string | null = null,
  enforceExternal = true,
): PvmDescriptor | null {
  if (!Object.hasOwn(files, "manifest.json")) {
    return null;
  }
  const bytes = files["manifest.json"];
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  const manifest = object(value);
  const runtime = object(manifest?.runtime);
  if (runtime?.kind !== "polkavm") {
    return null;
  }

  const programPath = cleanPath(runtime.entrypoint);
  if (programPath?.endsWith(".polkavm") !== true) {
    throw new Error("PolkaVM manifest has an invalid runtime entrypoint");
  }
  const modalities = object(manifest?.modalities);
  let graphicsProfile: "framebuffer" | "tri2d" | "webgpu-raster";
  let webGpuRequirements: WebGpuRequirements | null = null;
  let controls: string[];
  let audioEnabled: boolean;
  let manifestVersion: number | null = null;
  if (manifest?.$v === 2 && manifest.kind === "app") {
    if (runtime.abiVersion !== 1) {
      throw new Error("PolkaVM App v2 runtime requires ABI version 1");
    }
    const capabilities = object(manifest.capabilities);
    const graphics = object(capabilities?.graphics);
    if (
      graphics?.abiVersion !== 1 ||
      !["framebuffer", "tri2d", "webgpu-raster"].includes(
        String(graphics.profile),
      )
    ) {
      throw new Error(
        "dotli supports framebuffer, Tri2D, and WebGPU Raster ABI version 1 PolkaVM Apps",
      );
    }
    graphicsProfile = graphics.profile as
      | "framebuffer"
      | "tri2d"
      | "webgpu-raster";
    const graphicsFeatures = Array.isArray(graphics.requiredFeatures)
      ? graphics.requiredFeatures
      : null;
    if (
      graphicsFeatures === null ||
      graphicsFeatures.some((feature) => typeof feature !== "string") ||
      graphicsFeatures.length > 0
    ) {
      throw new Error("PolkaVM App v2 requires unsupported graphics features");
    }
    if (graphicsProfile === "webgpu-raster") {
      const requiredLimits = object(graphics.requiredLimits);
      if (requiredLimits === null) {
        throw new Error("WebGPU Raster requires explicit bounded limits");
      }
      const limits: Record<string, number> = {};
      for (const [name, value] of Object.entries(requiredLimits)) {
        if (
          !Number.isSafeInteger(value) ||
          (value as number) <= 0 ||
          ![
            "maxTextureDimension2D",
            "maxBufferSize",
            "maxBindingsPerBindGroup",
            "maxBindGroups",
            "maxVertexBuffers",
            "maxVertexAttributes",
            "maxColorAttachments",
          ].includes(name)
        ) {
          throw new Error(`WebGPU Raster requires unsupported limit ${name}`);
        }
        limits[name] = value as number;
      }
      webGpuRequirements = {
        requiredFeatures: graphicsFeatures as string[],
        requiredLimits: limits,
      };
    } else if (graphics.requiredLimits !== undefined) {
      throw new Error("non-WebGPU graphics profiles cannot require GPU limits");
    }
    const deviceInput =
      capabilities?.deviceInput === undefined
        ? null
        : object(capabilities.deviceInput);
    const deviceFeatures =
      deviceInput === null
        ? []
        : Array.isArray(deviceInput.requiredFeatures)
          ? deviceInput.requiredFeatures
          : null;
    const optionalDeviceFeatures =
      deviceInput === null
        ? []
        : Array.isArray(deviceInput.optionalFeatures)
          ? deviceInput.optionalFeatures
          : [];
    if (
      (deviceInput !== null && deviceInput.abiVersion !== 1) ||
      deviceFeatures === null ||
      deviceFeatures.some(
        (feature) =>
          typeof feature !== "string" ||
          !["pointer", "keyboard"].includes(feature),
      ) ||
      optionalDeviceFeatures.some((feature) => typeof feature !== "string") ||
      optionalDeviceFeatures.length > 0
    ) {
      throw new Error("PolkaVM App v2 requires unsupported device input");
    }
    const audio =
      capabilities?.audio === undefined ? null : object(capabilities.audio);
    if (
      audio !== null &&
      (audio.abiVersion !== 1 ||
        !Array.isArray(audio.requiredFeatures) ||
        audio.requiredFeatures.length > 0)
    ) {
      throw new Error("PolkaVM App v2 requires unsupported audio features");
    }
    controls = deviceFeatures.map(
      (feature) =>
        (feature as string)[0].toUpperCase() + (feature as string).slice(1),
    );
    audioEnabled = audio !== null;
    manifestVersion = 2;
    if (enforceExternal) {
      assertExternalManifest(bytes, externalManifest);
    }
  } else if (
    manifest?.$schema === "epoca:experimental-product/v1" &&
    manifest.$v === 1 &&
    manifest.kind === "framebuffer"
  ) {
    const framebuffer = object(modalities?.framebuffer);
    if (framebuffer?.abiVersion !== 1) {
      throw new Error("PolkaVM framebuffer manifest requires ABI version 1");
    }
    controls = Array.isArray(framebuffer.controls)
      ? framebuffer.controls.filter(
          (control): control is string => typeof control === "string",
        )
      : [];
    audioEnabled = true;
    graphicsProfile = "framebuffer";
  } else if (
    manifest?.$schema === "epoca:experimental-product/v2" &&
    manifest.$v === 2 &&
    manifest.kind === "application"
  ) {
    const graphics = object(modalities?.graphics);
    if (graphics?.abiVersion !== 1 || graphics.profile !== "framebuffer") {
      throw new Error(
        "dotli currently supports only framebuffer ABI version 1 PolkaVM applications",
      );
    }
    const generalInput = object(modalities?.generalInput);
    controls = Array.isArray(generalInput?.controls)
      ? generalInput.controls.filter(
          (control): control is string => typeof control === "string",
        )
      : [];
    audioEnabled = modalities?.audio !== undefined;
    graphicsProfile = "framebuffer";
  } else {
    throw new Error("PolkaVM package uses an unsupported manifest version");
  }

  const requiredAssets: string[] = [];
  if (Array.isArray(manifest.contentSlots)) {
    for (const slotValue of manifest.contentSlots) {
      const slot = object(slotValue);
      const mount = cleanPath(slot?.mount);
      if (slot?.required === true && mount !== null) {
        requiredAssets.push(mount);
      }
    }
  }
  return {
    graphicsProfile,
    webGpuRequirements,
    programPath,
    controls,
    audioEnabled,
    requiredAssets,
    manifestVersion,
  };
}

export function isPvmPackage(files: ArchiveFiles): boolean {
  return parseManifest(files, null, false) !== null;
}

export function describePvmPackage(
  files: ArchiveFiles,
  externalManifest: string | null = null,
): PvmDescriptor | null {
  return parseManifest(files, externalManifest);
}

function validateFiles(files: ArchiveFiles, descriptor: PvmDescriptor): void {
  if (!Object.hasOwn(files, descriptor.programPath)) {
    throw new Error("PolkaVM package is missing its program");
  }
  const program = files[descriptor.programPath];
  if (program.byteLength === 0 || program.byteLength > MAX_PROGRAM_BYTES) {
    throw new Error("PolkaVM package has an oversized program");
  }
  const entries = Object.entries(files).filter(
    ([path]) => path !== "manifest.json" && path !== descriptor.programPath,
  );
  if (entries.length > MAX_ASSET_FILES) {
    throw new Error("PolkaVM package contains too many assets");
  }
  let total = 0;
  for (const [path, bytes] of entries) {
    if (cleanPath(path) === null || bytes.byteLength > MAX_ASSET_FILE_BYTES) {
      throw new Error(`PolkaVM package has an invalid asset: ${path}`);
    }
    total += bytes.byteLength;
    if (total > MAX_ASSET_BYTES) {
      throw new Error("PolkaVM package exceeds the asset byte limit");
    }
  }
  for (const path of descriptor.requiredAssets) {
    if (!Object.hasOwn(files, path)) {
      throw new Error(
        `PolkaVM package is missing required content mount ${path}`,
      );
    }
  }
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  return bytes;
}

export interface TruapiPortScope {
  __HOST_API_PORT__?: MessagePort;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
}

export interface TruapiPortTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

export function waitForTruapiPort(
  scope: TruapiPortScope = window,
  target: TruapiPortTarget = window.parent,
  timeoutMs = TRUAPI_PORT_TIMEOUT_MS,
): Promise<MessagePort> {
  if (scope.__HOST_API_PORT__ instanceof MessagePort) {
    return Promise.resolve(scope.__HOST_API_PORT__);
  }

  const { promise, resolve, reject } = Promise.withResolvers<MessagePort>();
  let timer = 0;
  const cleanup = (): void => {
    globalThis.clearTimeout(timer);
    scope.removeEventListener("message", onMessage);
  };
  const onMessage = (event: MessageEvent<unknown>): void => {
    if (event.source !== target || object(event.data)?.type !== "truapi-init") {
      return;
    }
    const [port] = event.ports;
    if (!(port instanceof MessagePort)) {
      cleanup();
      reject(new Error("TrUAPI initialization did not include a MessagePort"));
      return;
    }
    cleanup();
    scope.__HOST_API_PORT__ = port;
    resolve(port);
  };
  scope.addEventListener("message", onMessage);
  timer = globalThis.setTimeout(() => {
    cleanup();
    reject(
      new Error(
        `TrUAPI Host port was not available within ${String(timeoutMs)}ms`,
      ),
    );
  }, timeoutMs);
  target.postMessage({ type: "truapi-ready" }, "*");
  return promise;
}

async function programDigest(program: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", ownedBytes(program).buffer),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function runtimeBytes(): Promise<ArrayBuffer> {
  runtimeBytesPromise ??= fetch(
    `${PVM_RUNTIME_ROOT}/pvm-browser-runtime.wasm`,
    {
      cache: "force-cache",
    },
  ).then((response) => {
    if (!response.ok) {
      throw new Error(
        `PolkaVM runtime fetch failed: HTTP ${String(response.status)}`,
      );
    }
    return response.arrayBuffer();
  });
  return runtimeBytesPromise;
}

function openSaveDb(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open(SAVE_DB_NAME, SAVE_DB_VERSION);
  request.onerror = () => {
    reject(request.error ?? new Error("save DB failed"));
  };
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(SAVE_STORE)) {
      request.result.createObjectStore(SAVE_STORE);
    }
    if (!request.result.objectStoreNames.contains(TRANSLATION_STORE)) {
      request.result.createObjectStore(TRANSLATION_STORE);
    }
  };
  request.onsuccess = () => {
    resolve(request.result);
  };
  return promise;
}

async function loadSave(key: string): Promise<Uint8Array | null> {
  const db = await openSaveDb();
  try {
    const transaction = db.transaction(SAVE_STORE, "readonly");
    const request = transaction.objectStore(SAVE_STORE).get(key);
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("save read failed"));
    };
    const value = await promise;
    return value instanceof ArrayBuffer && value.byteLength <= MAX_SAVE_BYTES
      ? new Uint8Array(value)
      : null;
  } finally {
    db.close();
  }
}

async function storeSave(key: string, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SAVE_BYTES) {
    return;
  }
  const db = await openSaveDb();
  try {
    const transaction = db.transaction(SAVE_STORE, "readwrite");
    transaction.objectStore(SAVE_STORE).put(bytes.slice().buffer, key);
    const { promise, resolve, reject } = Promise.withResolvers<undefined>();
    transaction.oncomplete = () => {
      resolve(undefined);
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("save write failed"));
    };
    await promise;
  } finally {
    db.close();
  }
}

async function loadTranslation(
  key: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const db = await openSaveDb();
  try {
    const transaction = db.transaction(TRANSLATION_STORE, "readonly");
    const request = transaction.objectStore(TRANSLATION_STORE).get(key);
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("translation cache read failed"));
    };
    const value = await promise;
    return value instanceof ArrayBuffer &&
      value.byteLength > 0 &&
      value.byteLength <= MAX_TRANSLATED_WASM_BYTES
      ? new Uint8Array(value)
      : null;
  } finally {
    db.close();
  }
}

async function storeTranslation(key: string, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_TRANSLATED_WASM_BYTES) {
    return;
  }
  const db = await openSaveDb();
  try {
    const transaction = db.transaction(TRANSLATION_STORE, "readwrite");
    transaction
      .objectStore(TRANSLATION_STORE)
      .put(ownedBytes(bytes).buffer, key);
    const { promise, resolve, reject } = Promise.withResolvers<undefined>();
    transaction.oncomplete = () => {
      resolve(undefined);
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("translation cache write failed"));
    };
    await promise;
  } finally {
    db.close();
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

export function encodedInput(
  type: number,
  code: number,
  x = 0,
  y = 0,
): Uint8Array {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  bytes[0] = type;
  bytes[1] = code;
  if (type === 6) {
    view.setInt16(2, clamp(x, -32768, 32767), true);
    view.setInt16(4, clamp(y, -32768, 32767), true);
  } else {
    view.setUint16(2, clamp(x, 0, 65535), true);
    view.setUint16(4, clamp(y, 0, 65535), true);
  }
  return bytes;
}

// CoreVM's mouse ABI is a signed byte. Drop individual samples outside that
// range as pointer-lock discontinuities, then bound the normal backlog
// accumulated before the next display frame.
const MAX_COREVM_POINTER_DELTA = 127;

export function normalizedPointerDelta(
  movementX: number,
  movementY: number,
  firstAfterPointerLock: boolean,
): [number, number] | null {
  if (
    firstAfterPointerLock ||
    !Number.isFinite(movementX) ||
    !Number.isFinite(movementY) ||
    Math.abs(movementX) > MAX_COREVM_POINTER_DELTA ||
    Math.abs(movementY) > MAX_COREVM_POINTER_DELTA
  ) {
    return null;
  }
  return [movementX, movementY];
}

export function accumulateRelativePointerDelta(
  currentX: number,
  currentY: number,
  deltaX: number,
  deltaY: number,
): [number, number] {
  return [
    clamp(
      currentX + deltaX,
      -MAX_COREVM_POINTER_DELTA,
      MAX_COREVM_POINTER_DELTA,
    ),
    clamp(
      currentY + deltaY,
      -MAX_COREVM_POINTER_DELTA,
      MAX_COREVM_POINTER_DELTA,
    ),
  ];
}

function createShell(controls: string[]): {
  canvas: HTMLCanvasElement;
  status: HTMLElement;
  metrics: HTMLElement;
} {
  const style = document.createElement("style");
  style.textContent = `
    html,body{width:100%;height:100%;margin:0;background:#050505;color:#fff;overflow:hidden}
    #dotli-pvm-shell{width:100%;height:100%;display:grid;place-items:center;position:relative;background:#050505}
    #dotli-pvm-canvas{max-width:100%;max-height:100%;width:100%;height:100%;object-fit:contain;image-rendering:pixelated;outline:none}
    .dotli-pvm-overlay{position:absolute;left:12px;padding:5px 8px;background:#000b;border:1px solid #ffffff2b;border-radius:4px;font:11px/1.35 ui-monospace,monospace;pointer-events:none}
    #dotli-pvm-status{top:12px} #dotli-pvm-metrics{bottom:12px;white-space:pre}
    #dotli-pvm-controls{position:absolute;right:12px;bottom:12px;max-width:min(480px,70vw);font:11px/1.4 ui-monospace,monospace;color:#ddd;text-align:right}
  `;
  const shell = document.createElement("main");
  shell.id = "dotli-pvm-shell";
  const canvas = document.createElement("canvas");
  canvas.id = "dotli-pvm-canvas";
  canvas.tabIndex = 0;
  const status = document.createElement("div");
  status.id = "dotli-pvm-status";
  status.className = "dotli-pvm-overlay";
  status.textContent = "Translating PolkaVM application…";
  const metrics = document.createElement("div");
  metrics.id = "dotli-pvm-metrics";
  metrics.className = "dotli-pvm-overlay";
  const controlText = document.createElement("div");
  controlText.id = "dotli-pvm-controls";
  controlText.textContent = controls.join(" · ");
  shell.append(canvas, status, metrics, controlText);
  document.head.append(style);
  document.body.replaceChildren(shell);
  return { canvas, status, metrics };
}

function installInput(
  canvas: HTMLCanvasElement,
  graphicsProfile: "framebuffer" | "tri2d" | "webgpu-raster",
  send: (bytes: Uint8Array) => void,
  resumeAudio: () => void,
): { cleanup: () => void; sendSurfaceMetrics: () => void } {
  const pressed = new Set<number>();
  let firstMoveAfterPointerLock = false;
  let relativeX = 0;
  let relativeY = 0;
  let relativeFrame: number | null = null;
  const flushRelativePointer = (): void => {
    relativeFrame = null;
    const x = relativeX;
    const y = relativeY;
    relativeX = 0;
    relativeY = 0;
    if (x !== 0 || y !== 0) {
      send(encodedInput(6, 0, x, y));
    }
  };
  const queueRelativePointer = (x: number, y: number): void => {
    [relativeX, relativeY] = accumulateRelativePointerDelta(
      relativeX,
      relativeY,
      x,
      y,
    );
    relativeFrame ??= window.requestAnimationFrame(flushRelativePointer);
  };
  const pointerLockChanged = (): void => {
    if (relativeFrame !== null) {
      window.cancelAnimationFrame(relativeFrame);
      relativeFrame = null;
    }
    relativeX = 0;
    relativeY = 0;
    firstMoveAfterPointerLock = document.pointerLockElement === canvas;
  };
  const canvasPosition = (event: PointerEvent): [number, number] => {
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return [0, 0];
    }
    return [
      ((event.clientX - bounds.left) * canvas.width) / bounds.width,
      ((event.clientY - bounds.top) * canvas.height) / bounds.height,
    ];
  };
  const keydown = (event: KeyboardEvent): void => {
    if (!(event.code in keyCodes) || event.repeat) {
      return;
    }
    const code = keyCodes[event.code];
    if (pressed.has(code)) {
      return;
    }
    event.preventDefault();
    pressed.add(code);
    resumeAudio();
    send(encodedInput(1, code));
  };
  const keyup = (event: KeyboardEvent): void => {
    if (!(event.code in keyCodes)) {
      return;
    }
    const code = keyCodes[event.code];
    if (!pressed.delete(code)) {
      return;
    }
    event.preventDefault();
    send(encodedInput(2, code));
  };
  const pointer = (event: PointerEvent, type: 3 | 4): void => {
    if (!(event.button in pointerButtons)) {
      return;
    }
    event.preventDefault();
    resumeAudio();
    const [x, y] = canvasPosition(event);
    send(encodedInput(type, pointerButtons[event.button], x, y));
  };
  const move = (event: PointerEvent): void => {
    if (graphicsProfile !== "framebuffer") {
      const [x, y] = canvasPosition(event);
      send(encodedInput(5, 0, x, y));
      return;
    }
    if (document.pointerLockElement !== canvas) {
      return;
    }
    const delta = normalizedPointerDelta(
      event.movementX,
      event.movementY,
      firstMoveAfterPointerLock,
    );
    firstMoveAfterPointerLock = false;
    if (delta !== null) {
      // Pointer events can outpace a guest frame by an order of magnitude.
      // Coalesce them once per display frame so a render stall cannot replay
      // a stale queue as one camera snap.
      queueRelativePointer(delta[0], delta[1]);
    }
  };
  const down = (event: PointerEvent): void => {
    canvas.focus();
    if (graphicsProfile !== "framebuffer") {
      move(event);
    }
    pointer(event, 3);
    if (
      graphicsProfile === "framebuffer" &&
      event.button === 0 &&
      document.pointerLockElement !== canvas
    ) {
      void canvas.requestPointerLock().catch(() => undefined);
    }
  };
  const up = (event: PointerEvent): void => {
    pointer(event, 4);
  };
  const contextmenu = (event: MouseEvent): void => {
    event.preventDefault();
  };
  const sendSurfaceMetrics = (): void => {
    if (graphicsProfile !== "tri2d") {
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    const scale = Math.max(1 / 32, Math.min(3, window.devicePixelRatio || 1));
    const width = clamp(bounds.width * scale, 1, 4_096);
    const height = clamp(bounds.height * scale, 1, 4_096);
    send(encodedInput(7, clamp(scale * 32, 1, 96), width, height));
  };
  const resizeObserver =
    graphicsProfile === "tri2d"
      ? new ResizeObserver(() => {
          sendSurfaceMetrics();
        })
      : null;
  resizeObserver?.observe(canvas);
  document.addEventListener("pointerlockchange", pointerLockChanged);
  window.addEventListener("keydown", keydown);
  window.addEventListener("keyup", keyup);
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("contextmenu", contextmenu);
  return {
    sendSurfaceMetrics,
    cleanup: () => {
      resizeObserver?.disconnect();
      pointerLockChanged();
      document.removeEventListener("pointerlockchange", pointerLockChanged);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("contextmenu", contextmenu);
    },
  };
}

export async function runPvmApplication(
  files: ArchiveFiles,
  cid: string,
  externalManifest: string | null = null,
): Promise<void> {
  const descriptor = parseManifest(files, externalManifest);
  if (descriptor === null) {
    throw new Error("package is not a PolkaVM application");
  }
  validateFiles(files, descriptor);
  const forceInterpreter =
    new URLSearchParams(location.search).get("pvmMode") === "interpreter";

  const started = performance.now();
  const {
    canvas,
    status,
    metrics: metricsElement,
  } = createShell(descriptor.controls);
  if (forceInterpreter) {
    status.textContent = "Starting PolkaVM interpreter…";
  }
  const context =
    descriptor.graphicsProfile === "framebuffer"
      ? canvas.getContext("2d", { alpha: false })
      : null;
  if (descriptor.graphicsProfile === "framebuffer" && context === null) {
    throw new Error("2D canvas is unavailable");
  }
  const tri2d =
    descriptor.graphicsProfile === "tri2d" ? new Tri2dRenderer(canvas) : null;
  canvas.dataset.pvmProfile = descriptor.graphicsProfile;

  const runtime = await runtimeBytes();
  const program = ownedBytes(files[descriptor.programPath]);
  const cacheKey = `${RUNTIME_SOURCE}:${await programDigest(program)}`;
  const compiledModule = forceInterpreter
    ? undefined
    : compiledModules.get(cacheKey);
  const compiledBytes =
    !forceInterpreter && compiledModule === undefined
      ? await loadTranslation(cacheKey)
      : null;
  let saveIdentity = cid;
  if (descriptor.requiredAssets.length > 0) {
    const fingerprints: string[] = [];
    for (const path of [...descriptor.requiredAssets].sort()) {
      fingerprints.push(path, await programDigest(files[path]));
    }
    saveIdentity = await programDigest(
      encoder.encode(fingerprints.join("\u0000")),
    );
  }
  const saveKey = `${location.hostname}:${saveIdentity}`;
  const assets = Object.entries(files)
    .filter(
      ([path]) => path !== "manifest.json" && path !== descriptor.programPath,
    )
    .map(([path, bytes]) => ({ path, bytes: ownedBytes(bytes) }));
  const save = await loadSave(saveKey);
  if (
    save !== null &&
    !assets.some((asset) => asset.path === "save/cartridge.sav")
  ) {
    assets.push({ path: "save/cartridge.sav", bytes: ownedBytes(save) });
  }

  const parentOrigin = (() => {
    try {
      return document.referrer === ""
        ? null
        : new URL(document.referrer).origin;
    } catch {
      return null;
    }
  })();
  let reportedUsesMotion: boolean | null = null;
  const postCapabilities = (): void => {
    if (reportedUsesMotion === null) {
      return;
    }
    window.parent.postMessage(
      {
        type: "dotli:pvm-capabilities",
        usesMotion: reportedUsesMotion,
      },
      parentOrigin ?? "*",
    );
  };
  const onCapabilityRequest = (event: MessageEvent<unknown>): void => {
    if (
      event.source === window.parent &&
      (parentOrigin === null || event.origin === parentOrigin) &&
      typeof event.data === "object" &&
      event.data !== null &&
      "type" in event.data &&
      event.data.type === "dotli:pvm-capabilities-request"
    ) {
      postCapabilities();
    }
  };
  window.addEventListener("message", onCapabilityRequest);
  const onMotion = (event: MessageEvent<unknown>): void => {
    if (
      event.source !== window.parent ||
      (parentOrigin !== null && event.origin !== parentOrigin) ||
      typeof event.data !== "object" ||
      event.data === null
    ) {
      return;
    }
    const message = event.data as {
      type?: unknown;
      availability?: unknown;
      bytes?: unknown;
    };
    if (
      message.type === "dotli:pvm-motion-status" &&
      Number.isInteger(message.availability) &&
      Number(message.availability) >= 0 &&
      Number(message.availability) <= 2
    ) {
      const availability = Number(message.availability);
      worker.postMessage({ type: "motion-status", availability });
      canvas.dataset.pvmMotion =
        availability === 1
          ? "active"
          : availability === 2
            ? "denied"
            : "unavailable";
    } else if (message.type === "dotli:pvm-motion-sample") {
      const source =
        message.bytes instanceof ArrayBuffer
          ? new Uint8Array(message.bytes)
          : message.bytes instanceof Uint8Array
            ? message.bytes
            : null;
      if (source?.byteLength !== 48) {
        return;
      }
      const bytes = ownedBytes(source);
      worker.postMessage({ type: "motion", bytes }, [bytes.buffer]);
      canvas.dataset.pvmMotion = "active";
    }
  };
  let motionBridgeAttached = false;
  const attachMotionBridge = (): void => {
    if (motionBridgeAttached) {
      return;
    }
    motionBridgeAttached = true;
    canvas.dataset.pvmMotion = "permission-required";
    window.addEventListener("message", onMotion);
  };
  const worker = new Worker(`${PVM_RUNTIME_ROOT}/pvm-wasm-worker.js`);
  const {
    promise: startedPromise,
    resolve: resolveStarted,
    reject: rejectStarted,
  } = Promise.withResolvers<undefined>();
  const truapiPort = await waitForTruapiPort();
  canvas.dataset.pvmTruapiRequests = "0";
  canvas.dataset.pvmTruapiResponses = "0";
  const failTruapi = (error: Error): void => {
    status.textContent = error.message;
    rejectStarted(error);
    worker.postMessage({ type: "stop" });
    worker.terminate();
    truapiPort.onmessage = null;
    truapiPort.onmessageerror = null;
    truapiPort.close();
  };
  let truapiReady = false;
  let pendingTruapiBytes = 0;
  const pendingTruapiResponses: Uint8Array<ArrayBuffer>[] = [];
  const sendTruapiResponse = (value: Uint8Array): void => {
    const bytes = ownedBytes(value);
    worker.postMessage({ type: "truapi-response", bytes }, [bytes.buffer]);
  };
  truapiPort.onmessage = (event: MessageEvent<unknown>): void => {
    if (
      !(event.data instanceof Uint8Array) ||
      event.data.byteLength === 0 ||
      event.data.byteLength > MAX_TRUAPI_FRAME_BYTES
    ) {
      failTruapi(new Error("TrUAPI Host returned an invalid PVM frame"));
      return;
    }
    const bytes = ownedBytes(event.data);
    canvas.dataset.pvmTruapiResponses = String(
      Number(canvas.dataset.pvmTruapiResponses) + 1,
    );
    if (truapiReady) {
      sendTruapiResponse(bytes);
      return;
    }
    if (
      pendingTruapiResponses.length === MAX_TRUAPI_PENDING_FRAMES ||
      pendingTruapiBytes + bytes.byteLength > MAX_TRUAPI_PENDING_BYTES
    ) {
      failTruapi(
        new Error("TrUAPI response queue overflow during PVM startup"),
      );
      return;
    }
    pendingTruapiBytes += bytes.byteLength;
    pendingTruapiResponses.push(bytes);
  };
  truapiPort.onmessageerror = () => {
    failTruapi(new Error("TrUAPI Host port could not decode a PVM frame"));
  };
  truapiPort.start();
  let audioContext: AudioContext | null = null;
  let audioCursor = 0;
  let firstFrame = false;
  let frameWindowStarted = performance.now();
  let frameWindowCount = 0;
  const pvmMetrics: PvmMetrics = {
    backend: "starting",
    cacheHit: false,
    translationMs: 0,
    compilationMs: 0,
    startupMs: 0,
    startupStage: "worker-created",
    firstFrameMs: 0,
    translatedWasmBytes: 0,
    frames: 0,
    fps: 0,
    updates: 0,
    updateP50Ms: 0,
    updateP95Ms: 0,
    updateMaxMs: 0,
    audioChunks: 0,
    audioSamples: 0,
  };
  window.__dotliPvmMetrics = pvmMetrics;

  const updateMetrics = (): void => {
    metricsElement.textContent = [
      `${pvmMetrics.backend.toUpperCase()}  ${pvmMetrics.fps.toFixed(1)} FPS`,
      `stage ${pvmMetrics.startupStage}`,
      `translate ${pvmMetrics.translationMs.toFixed(1)} ms  compile ${pvmMetrics.compilationMs.toFixed(1)} ms`,
      `update p50 ${pvmMetrics.updateP50Ms.toFixed(2)} ms  p95 ${pvmMetrics.updateP95Ms.toFixed(2)} ms  max ${pvmMetrics.updateMaxMs.toFixed(2)} ms`,
    ].join("\n");
    canvas.dataset.pvmBackend = pvmMetrics.backend;
    canvas.dataset.pvmCacheHit = String(pvmMetrics.cacheHit);
    canvas.dataset.pvmTranslationMs = String(pvmMetrics.translationMs);
    canvas.dataset.pvmCompilationMs = String(pvmMetrics.compilationMs);
    canvas.dataset.pvmStartupMs = String(pvmMetrics.startupMs);
    canvas.dataset.pvmStartupStage = pvmMetrics.startupStage;
    canvas.dataset.pvmFirstFrameMs = String(pvmMetrics.firstFrameMs);
    canvas.dataset.pvmFrames = String(pvmMetrics.frames);
    canvas.dataset.pvmFps = String(pvmMetrics.fps);
    canvas.dataset.pvmUpdates = String(pvmMetrics.updates);
    canvas.dataset.pvmUpdateP50Ms = String(pvmMetrics.updateP50Ms);
    canvas.dataset.pvmUpdateP95Ms = String(pvmMetrics.updateP95Ms);
    canvas.dataset.pvmUpdateMaxMs = String(pvmMetrics.updateMaxMs);
    canvas.dataset.pvmAudioChunks = String(pvmMetrics.audioChunks);
    canvas.dataset.pvmAudioSamples = String(pvmMetrics.audioSamples);
  };
  const setStartupStage = (stage: string): void => {
    if (firstFrame) {
      return;
    }
    pvmMetrics.startupStage = stage;
    status.textContent = `PVM startup: ${stage.replaceAll("-", " ")}…`;
    updateMetrics();
  };
  const presentedFrame = (): void => {
    pvmMetrics.frames++;
    canvas.dataset.pvmFrames = String(pvmMetrics.frames);
    frameWindowCount++;
    const now = performance.now();
    if (now - frameWindowStarted >= 500) {
      pvmMetrics.fps = (frameWindowCount * 1000) / (now - frameWindowStarted);
      frameWindowStarted = now;
      frameWindowCount = 0;
      updateMetrics();
    }
    if (!firstFrame) {
      firstFrame = true;
      pvmMetrics.firstFrameMs = now - started;
      pvmMetrics.startupStage = "first-frame";
      status.textContent = "";
      window.clearTimeout(timer);
      updateMetrics();
      resolveStarted(undefined);
    }
  };

  const resumeAudio = (): void => {
    audioContext ??= new AudioContext({ sampleRate: 48_000 });
    if (audioContext.state === "suspended") {
      void audioContext.resume();
    }
  };
  const playAudio = (message: WorkerAudio): void => {
    if (
      !Number.isInteger(message.channels) ||
      message.channels < 1 ||
      message.channels > 2 ||
      !Number.isInteger(message.sampleRate) ||
      message.sampleRate < 8_000 ||
      message.sampleRate > 96_000 ||
      !(message.samples instanceof Uint8Array) ||
      message.samples.byteLength === 0 ||
      message.samples.byteLength > MAX_AUDIO_BYTES ||
      message.samples.byteLength % (message.channels * 2) !== 0
    ) {
      return;
    }
    pvmMetrics.audioChunks++;
    pvmMetrics.audioSamples += message.samples.byteLength / 2;
    canvas.dataset.pvmAudioChunks = String(pvmMetrics.audioChunks);
    canvas.dataset.pvmAudioSamples = String(pvmMetrics.audioSamples);
    if (
      canvas.dataset.pvmAudioNonzero !== "true" &&
      message.samples.some((byte) => byte !== 0)
    ) {
      canvas.dataset.pvmAudioNonzero = "true";
    }
    resumeAudio();
    if (audioContext?.state !== "running") {
      audioCursor = 0;
      return;
    }
    const samples = new Int16Array(
      message.samples.buffer,
      message.samples.byteOffset,
      message.samples.byteLength / 2,
    );
    const frameCount = samples.length / message.channels;
    const start = Math.max(audioCursor, audioContext.currentTime + 0.02);
    if (
      start + frameCount / message.sampleRate - audioContext.currentTime >
      0.25
    ) {
      return;
    }
    const buffer = audioContext.createBuffer(
      message.channels,
      frameCount,
      message.sampleRate,
    );
    for (let channel = 0; channel < message.channels; channel++) {
      const output = buffer.getChannelData(channel);
      for (let index = 0; index < frameCount; index++) {
        output[index] = samples[index * message.channels + channel] / 32768;
      }
    }
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.start(start);
    audioCursor = start + buffer.duration;
  };

  const startTimeoutMs = forceInterpreter
    ? INTERPRETER_START_TIMEOUT_MS
    : START_TIMEOUT_MS;
  const timer = window.setTimeout(() => {
    rejectStarted(
      new Error(
        `${forceInterpreter ? "PolkaVM interpreter" : "PolkaVM application"} did not present a frame within ${String(startTimeoutMs / 1000)}s (last stage: ${pvmMetrics.startupStage})`,
      ),
    );
  }, startTimeoutMs);
  let webGpu: WebGpuRasterBridge | null = null;
  let gpuCapabilities: Uint8Array | null = null;
  if (descriptor.graphicsProfile === "webgpu-raster") {
    if (descriptor.webGpuRequirements === null) {
      throw new Error("WebGPU Raster requirements are missing");
    }
    webGpu = new WebGpuRasterBridge(canvas, descriptor.webGpuRequirements, {
      event: (bytes) => {
        worker.postMessage({ type: "gpu-event", bytes }, [bytes.buffer]);
      },
      presented: presentedFrame,
      error: (error) => {
        status.textContent = error.message;
        rejectStarted(error);
      },
    });
    gpuCapabilities = await webGpu.capabilities;
  }

  const { cleanup: cleanupInput, sendSurfaceMetrics } = installInput(
    canvas,
    descriptor.graphicsProfile,
    (bytes) => {
      worker.postMessage({ type: "input", bytes }, [bytes.buffer]);
    },
    resumeAudio,
  );
  const stop = (): void => {
    cleanupInput();
    if (motionBridgeAttached) {
      window.removeEventListener("message", onMotion);
    }
    window.removeEventListener("message", onCapabilityRequest);
    tri2d?.dispose();
    worker.postMessage({ type: "stop" });
    webGpu?.dispose();
    worker.terminate();
    void audioContext?.close();
    truapiPort.onmessage = null;
    truapiPort.onmessageerror = null;
    truapiPort.close();
  };
  window.addEventListener("pagehide", stop, { once: true });

  worker.onmessage = (event: MessageEvent<unknown>): void => {
    const message = object(event.data);
    switch (message?.type) {
      case "startup": {
        const startup = message as unknown as WorkerStartup;
        if (typeof startup.stage === "string" && startup.stage !== "") {
          setStartupStage(startup.stage);
        }
        break;
      }
      case "translated": {
        setStartupStage("translated");
        if (
          message.cacheKey === cacheKey &&
          message.bytes instanceof Uint8Array
        ) {
          void storeTranslation(cacheKey, message.bytes);
        }
        break;
      }
      case "compiled": {
        setStartupStage("compiled");
        if (
          message.cacheKey === cacheKey &&
          message.module instanceof WebAssembly.Module
        ) {
          compiledModules.delete(cacheKey);
          compiledModules.set(cacheKey, message.module);
          if (compiledModules.size > 8) {
            const oldest = compiledModules.keys().next().value;
            if (oldest !== undefined) {
              compiledModules.delete(oldest);
            }
          }
        }
        break;
      }
      case "ready": {
        const ready = message as unknown as WorkerReady;
        pvmMetrics.backend = ready.backend;
        pvmMetrics.cacheHit = ready.cacheHit === true;
        pvmMetrics.translationMs = ready.translationMs ?? 0;
        pvmMetrics.compilationMs = ready.compilationMs ?? 0;
        pvmMetrics.startupMs = ready.startupMs ?? 0;
        pvmMetrics.translatedWasmBytes = ready.translatedWasmBytes ?? 0;
        pvmMetrics.startupStage = "ready";
        status.textContent = `${ready.backend === "compiler" ? "PVM→Wasm JIT" : "PVM interpreter"} ready`;
        canvas.dataset.pvmReady = "true";
        updateMetrics();
        reportedUsesMotion = ready.usesMotion;
        if (ready.usesMotion) {
          attachMotionBridge();
        }
        postCapabilities();
        sendSurfaceMetrics();
        truapiReady = true;
        for (const response of pendingTruapiResponses.splice(0)) {
          pendingTruapiBytes -= response.byteLength;
          sendTruapiResponse(response);
        }
        break;
      }
      case "truapi-request": {
        const bytes = message.bytes;
        if (
          !(bytes instanceof Uint8Array) ||
          bytes.byteLength === 0 ||
          bytes.byteLength > MAX_TRUAPI_FRAME_BYTES
        ) {
          failTruapi(
            new Error("PolkaVM guest emitted an invalid TrUAPI frame"),
          );
          return;
        }
        const request = ownedBytes(bytes);
        canvas.dataset.pvmTruapiRequests = String(
          Number(canvas.dataset.pvmTruapiRequests) + 1,
        );
        truapiPort.postMessage(request, [request.buffer]);
        break;
      }
      case "frame": {
        const frame = message as unknown as WorkerFrame;
        if (
          descriptor.graphicsProfile !== "framebuffer" ||
          context === null ||
          !Number.isInteger(frame.width) ||
          !Number.isInteger(frame.height) ||
          frame.width <= 0 ||
          frame.height <= 0 ||
          !(frame.pixels instanceof Uint8Array) ||
          frame.pixels.byteLength !== frame.width * frame.height * 4
        ) {
          rejectStarted(
            new Error("PolkaVM guest emitted an invalid framebuffer"),
          );
          return;
        }
        canvas.width = frame.width;
        canvas.height = frame.height;
        const pixels = new Uint8ClampedArray(frame.pixels.byteLength);
        pixels.set(frame.pixels);
        context.putImageData(
          new ImageData(pixels, frame.width, frame.height),
          0,
          0,
        );
        presentedFrame();
        break;
      }
      case "tri2d": {
        const frame = message as unknown as WorkerTri2d;
        if (
          descriptor.graphicsProfile !== "tri2d" ||
          tri2d === null ||
          !(frame.bytes instanceof Uint8Array)
        ) {
          rejectStarted(
            new Error("PolkaVM guest emitted an invalid Tri2D frame"),
          );
          return;
        }
        try {
          const metadata = tri2d.render(frame.bytes);
          canvas.dataset.pvmTri2dDraws = String(metadata.drawCount);
          canvas.dataset.pvmTri2dVertices = String(metadata.vertexCount);
          canvas.dataset.pvmTri2dIndices = String(metadata.indexCount);
          presentedFrame();
        } catch (error) {
          rejectStarted(error);
        }
        break;
      }
      case "gpu-batch": {
        const batch = message as unknown as WorkerGpuBatch;
        if (
          descriptor.graphicsProfile !== "webgpu-raster" ||
          webGpu === null ||
          !(batch.bytes instanceof Uint8Array) ||
          batch.bytes.byteLength === 0 ||
          batch.bytes.byteLength > 4 * 1024 * 1024
        ) {
          rejectStarted(
            new Error("PolkaVM guest emitted an invalid WebGPU Raster batch"),
          );
          return;
        }
        webGpu.submit(batch.bytes);
        break;
      }
      case "audio":
        playAudio(message as unknown as WorkerAudio);
        break;
      case "save": {
        const bytes = message.bytes;
        if (bytes instanceof Uint8Array) {
          void storeSave(saveKey, bytes);
        }
        break;
      }
      case "metrics": {
        const values = message as unknown as WorkerMetrics;
        pvmMetrics.updates = values.updates;
        pvmMetrics.updateP50Ms = values.updateP50Ms;
        pvmMetrics.updateP95Ms = values.updateP95Ms;
        pvmMetrics.updateMaxMs = values.updateMaxMs;
        updateMetrics();
        break;
      }
      case "log": {
        const text = typeof message.message === "string" ? message.message : "";
        console.warn(`[PolkaVM] ${text}`);
        break;
      }
      case "error": {
        const text =
          typeof message.message === "string"
            ? message.message
            : "PolkaVM runtime failed";
        const error = new Error(text);
        status.textContent = error.message;
        rejectStarted(error);
        break;
      }
    }
  };
  worker.onerror = (event: ErrorEvent): void => {
    rejectStarted(
      new Error(
        event.message
          ? `PolkaVM worker failed: ${event.message}`
          : "PolkaVM worker failed",
      ),
    );
  };

  const runtimeCopy = runtime.slice(0);
  const transfers: Transferable[] = [runtimeCopy, program.buffer];
  if (compiledBytes !== null) {
    transfers.push(compiledBytes.buffer);
  }
  for (const asset of assets) {
    transfers.push(asset.bytes.buffer);
  }
  const gpuCapabilitiesBuffer = gpuCapabilities?.buffer;
  if (gpuCapabilitiesBuffer !== undefined) {
    transfers.push(gpuCapabilitiesBuffer);
  }
  worker.postMessage(
    {
      type: "start",
      runtime: runtimeCopy,
      program,
      assets,
      audioEnabled: descriptor.audioEnabled,
      cacheKey,
      compiledModule,
      compiledBytes: compiledBytes?.buffer,
      graphicsProfile: descriptor.graphicsProfile,
      gpuCapabilities: gpuCapabilitiesBuffer,
      forceInterpreter,
    },
    transfers,
  );

  await startedPromise.catch((error: unknown) => {
    stop();
    throw error;
  });
}
