// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ArchiveFiles } from "@dotli/content/archive";
import { Tri2dRenderer } from "./tri2d-renderer";
import { WebGpuBridge, type WebGpuRequirements } from "./webgpu";

const POLKAVM_RUNTIME_ROOT = "/polkavm-runtime";
const MAX_PROGRAM_BYTES = 64 * 1024 * 1024;
const MAX_ASSET_FILES = 2_048;
const MAX_ASSET_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ASSET_BYTES = 128 * 1024 * 1024;
const MAX_AUDIO_BYTES = 48_000 * 2 * 2;
const MAX_SAVE_BYTES = 1024 * 1024;
const MAX_TRANSLATED_WASM_BYTES = 16 * 1024 * 1024;
const MAX_HOST_FRAME_BYTES = 1024 * 1024;
const MAX_PENDING_HOST_FRAMES = 32;
const MAX_PENDING_HOST_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_UI_OUTPUT_COMMANDS = 64;
const MAX_UI_COPY_TEXT_BYTES = 64 * 1024;
const MAX_UI_OPEN_URL_BYTES = 8 * 1024;
const TRUAPI_PORT_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 30_000;
const INTERPRETER_START_TIMEOUT_MS = 180_000;
const SAVE_DB_NAME = "dotli-polkavm";
const SAVE_DB_VERSION = 2;
const SAVE_STORE = "saves";
const TRANSLATION_STORE = "translations";
const RUNTIME_SOURCE =
  "useragent-kit-polkavm-runtime-069f2ee4852f9d2b6053e1244b09136238b0c2eb";
type GraphicsProfile = "framebuffer" | "tri2d" | "webgpu-raster" | "webgpu";

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const compiledModules = new Map<string, WebAssembly.Module>();
let runtimeBytesPromise: Promise<ArrayBuffer> | null = null;

export interface PolkaVmMetrics {
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

type PolkaVmMetricsDisplaySource = Pick<
  PolkaVmMetrics,
  | "backend"
  | "fps"
  | "startupStage"
  | "translationMs"
  | "compilationMs"
  | "updateP50Ms"
  | "updateP95Ms"
  | "updateMaxMs"
>;

export function formatPolkaVmMetrics(metrics: PolkaVmMetricsDisplaySource): {
  summary: string;
  details: string;
} {
  const backend =
    metrics.backend === "compiler"
      ? "JIT"
      : metrics.backend === "interpreter"
        ? "Interpreter"
        : "Starting";
  return {
    summary: `PolkaVM / ${backend} · ${metrics.fps.toFixed(1)} FPS`,
    details: [
      `Stage: ${metrics.startupStage}`,
      `Translate ${metrics.translationMs.toFixed(1)} ms · Compile ${metrics.compilationMs.toFixed(1)} ms`,
      `Update p50 ${metrics.updateP50Ms.toFixed(2)} ms · p95 ${metrics.updateP95Ms.toFixed(2)} ms · max ${metrics.updateMaxMs.toFixed(2)} ms`,
    ].join("\n"),
  };
}

export function unsupportedPolkaVmImport(message: string): string | null {
  return (
    /translated (?:PolkaVM|CoreVM) guest uses unsupported import ([A-Za-z][A-Za-z0-9_]*)/.exec(
      message,
    )?.[1] ?? null
  );
}

declare global {
  interface Window {
    __dotliPolkaVmMetrics?: PolkaVmMetrics;
    __HOST_API_PORT__?: MessagePort;
  }
}

interface PolkaVmDescriptor {
  programPath: string;
  graphicsProfile: GraphicsProfile;
  webGpuRequirements: WebGpuRequirements | null;
  webFallbackPath: string | null;
  controls: string[];
  inputFeatures: string[];
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
  usesMotion?: boolean;
  usesPointerCapture?: boolean;
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

export type UiPlatformRect = readonly [number, number, number, number];

export type UiPlatformCommand =
  | Readonly<{ type: "copy-text"; text: string }>
  | Readonly<{ type: "open-url"; url: string }>;

export interface UiPlatformOutput {
  cursorIcon: string;
  mutableTextUnderCursor: boolean;
  ime: Readonly<{
    rect: UiPlatformRect;
    cursorRect: UiPlatformRect;
  }> | null;
  commands: readonly UiPlatformCommand[];
}

export interface UiPlatformCommandTarget {
  postMessage(
    message: Readonly<{
      type: "dotli:polkavm-ui-command";
      command: UiPlatformCommand;
    }>,
    targetOrigin: string,
  ): void;
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
const uiCursorIcons: Readonly<Partial<Record<string, true>>> = Object.freeze({
  default: true,
  none: true,
  "context-menu": true,
  help: true,
  pointer: true,
  progress: true,
  wait: true,
  cell: true,
  crosshair: true,
  text: true,
  "vertical-text": true,
  alias: true,
  copy: true,
  move: true,
  "no-drop": true,
  "not-allowed": true,
  grab: true,
  grabbing: true,
  "all-scroll": true,
  "ew-resize": true,
  "nesw-resize": true,
  "nwse-resize": true,
  "ns-resize": true,
  "e-resize": true,
  "se-resize": true,
  "s-resize": true,
  "sw-resize": true,
  "w-resize": true,
  "nw-resize": true,
  "n-resize": true,
  "ne-resize": true,
  "col-resize": true,
  "row-resize": true,
  "zoom-in": true,
  "zoom-out": true,
});

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function expectedPolkaVmParentOrigin(
  hostname: string,
  protocol: string,
  port: string,
): string | null {
  const marker = ".app.";
  const markerIndex = hostname.lastIndexOf(marker);
  if (
    markerIndex <= 0 ||
    markerIndex + marker.length >= hostname.length ||
    (protocol !== "https:" && protocol !== "http:")
  ) {
    return null;
  }
  const parentHostname =
    hostname.slice(0, markerIndex) +
    "." +
    hostname.slice(markerIndex + marker.length);
  return `${protocol}//${parentHostname}${port === "" ? "" : `:${port}`}`;
}

export function shouldReloadAfterWake(
  wasHidden: boolean,
  visibilityState: DocumentVisibilityState,
  restoredFromPageCache: boolean,
): boolean {
  return restoredFromPageCache || (wasHidden && visibilityState === "visible");
}

function uiPlatformRect(value: unknown): UiPlatformRect | null {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((coordinate) => Number.isFinite(coordinate)) ||
    value[2] < value[0] ||
    value[3] < value[1]
  ) {
    return null;
  }
  return [value[0], value[1], value[2], value[3]];
}

export function validatedUiPlatformOutput(
  value: unknown,
): UiPlatformOutput | null {
  const output = object(value);
  if (
    output === null ||
    typeof output.cursorIcon !== "string" ||
    !Object.hasOwn(uiCursorIcons, output.cursorIcon) ||
    typeof output.mutableTextUnderCursor !== "boolean" ||
    !Array.isArray(output.commands) ||
    output.commands.length > MAX_UI_OUTPUT_COMMANDS
  ) {
    return null;
  }

  let ime: UiPlatformOutput["ime"] = null;
  if (output.ime !== null) {
    const rawIme = object(output.ime);
    const rect = uiPlatformRect(rawIme?.rect);
    const cursorRect = uiPlatformRect(rawIme?.cursorRect);
    if (rawIme === null || rect === null || cursorRect === null) {
      return null;
    }
    ime = { rect, cursorRect };
  }

  const commands: UiPlatformCommand[] = [];
  for (const value of output.commands) {
    const command = object(value);
    if (command?.type === "copy-text") {
      if (
        typeof command.text !== "string" ||
        encoder.encode(command.text).byteLength > MAX_UI_COPY_TEXT_BYTES
      ) {
        return null;
      }
      commands.push({ type: "copy-text", text: command.text });
      continue;
    }
    if (command?.type === "open-url") {
      if (
        typeof command.url !== "string" ||
        command.url === "" ||
        encoder.encode(command.url).byteLength > MAX_UI_OPEN_URL_BYTES ||
        typeof command.newSurface !== "boolean"
      ) {
        return null;
      }
      commands.push({
        type: "open-url",
        url: command.url,
      });
      continue;
    }
    return null;
  }

  return {
    cursorIcon: output.cursorIcon,
    mutableTextUnderCursor: output.mutableTextUnderCursor,
    ime,
    commands,
  };
}

export function postFirstUiPlatformCommand(
  output: UiPlatformOutput,
  target: UiPlatformCommandTarget,
  targetOrigin: string | null,
): boolean {
  const command = output.commands.at(0);
  if (command === undefined || targetOrigin === null) {
    return false;
  }
  target.postMessage(
    { type: "dotli:polkavm-ui-command", command },
    targetOrigin,
  );
  return true;
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
): PolkaVmDescriptor | null {
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
  let graphicsProfile: GraphicsProfile;
  let webGpuRequirements: WebGpuRequirements | null = null;
  let controls: string[];
  let inputFeatures: string[];
  let audioEnabled: boolean;
  let manifestVersion: number | null = null;
  let webFallbackPath: string | null = null;
  if (manifest?.$v === 2 && manifest.kind === "app") {
    if (runtime.abiVersion !== 2) {
      throw new Error("PolkaVM App v2 runtime requires ABI version 2");
    }
    if (runtime.fallback !== undefined) {
      const fallback = object(runtime.fallback);
      webFallbackPath = cleanPath(fallback?.entrypoint);
      if (
        fallback?.kind !== "web" ||
        webFallbackPath?.endsWith(".html") !== true
      ) {
        throw new Error(
          "PolkaVM App v2 web fallback requires a relative HTML entrypoint",
        );
      }
    }
    const capabilities = object(manifest.capabilities);
    const graphics = object(capabilities?.graphics);
    if (
      graphics?.abiVersion !== 1 ||
      !["framebuffer", "tri2d", "webgpu-raster", "webgpu"].includes(
        String(graphics.profile),
      )
    ) {
      throw new Error(
        "dotli supports framebuffer, Tri2D, WebGPU Raster, and WebGPU ABI version 1 PolkaVM Apps",
      );
    }
    graphicsProfile = graphics.profile as GraphicsProfile;
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
    if (graphicsProfile === "webgpu-raster" || graphicsProfile === "webgpu") {
      const requiredLimits = object(graphics.requiredLimits);
      if (requiredLimits === null) {
        throw new Error("WebGPU requires explicit bounded limits");
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
            "maxStorageBufferBindingSize",
            "maxStorageBuffersPerShaderStage",
            "maxComputeWorkgroupStorageSize",
            "maxComputeInvocationsPerWorkgroup",
            "maxComputeWorkgroupSizeX",
            "maxComputeWorkgroupSizeY",
            "maxComputeWorkgroupSizeZ",
            "maxComputeWorkgroupsPerDimension",
          ].includes(name)
        ) {
          throw new Error(`WebGPU requires unsupported limit ${name}`);
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
    if (
      (deviceInput !== null && deviceInput.abiVersion !== 1) ||
      deviceFeatures === null ||
      deviceFeatures.some(
        (feature) =>
          typeof feature !== "string" ||
          ![
            "pointer",
            "keyboard",
            "text",
            "ime",
            "focus",
            "wheel",
            "motion",
          ].includes(feature),
      )
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
    inputFeatures = deviceFeatures as string[];
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
    inputFeatures = ["pointer", "keyboard", "motion"];
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
    inputFeatures = ["pointer", "keyboard", "motion"];
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
    webFallbackPath,
    programPath,
    controls,
    inputFeatures,
    audioEnabled,
    requiredAssets,
    manifestVersion,
  };
}

export function isPolkaVmPackage(files: ArchiveFiles): boolean {
  return parseManifest(files, null, false) !== null;
}

export function describePolkaVmPackage(
  files: ArchiveFiles,
  externalManifest: string | null = null,
): PolkaVmDescriptor | null {
  return parseManifest(files, externalManifest);
}

export function webGpuAdapterMeetsRequirements(
  adapter: GPUAdapter | null,
  requirements: WebGpuRequirements,
): boolean {
  if (adapter === null) {
    return false;
  }
  if (
    requirements.requiredFeatures.some(
      (feature) => !adapter.features.has(feature),
    )
  ) {
    return false;
  }
  const limits = adapter.limits as unknown as Record<string, number>;
  return Object.entries(requirements.requiredLimits).every(
    ([name, required]) => (limits[name] ?? 0) >= required,
  );
}

export async function polkavmWebFallbackEntrypoint(
  files: ArchiveFiles,
  externalManifest: string | null,
): Promise<string | null> {
  const descriptor = parseManifest(files, externalManifest);
  if (descriptor === null) {
    return null;
  }
  const { graphicsProfile, webFallbackPath, webGpuRequirements } = descriptor;
  if (
    webFallbackPath === null ||
    (graphicsProfile !== "webgpu-raster" && graphicsProfile !== "webgpu") ||
    webGpuRequirements === null
  ) {
    return null;
  }
  const gpu = Reflect.get(navigator, "gpu") as GPU | undefined;
  let adapter: GPUAdapter | null;
  try {
    adapter = gpu === undefined ? null : await gpu.requestAdapter();
  } catch {
    adapter = null;
  }
  if (webGpuAdapterMeetsRequirements(adapter, webGpuRequirements)) {
    return null;
  }
  if (!Object.hasOwn(files, webFallbackPath)) {
    throw new Error("PolkaVM web fallback entrypoint is missing");
  }
  return webFallbackPath;
}

export function validateFiles(
  files: ArchiveFiles,
  descriptor: PolkaVmDescriptor,
): void {
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
  scope: TruapiPortScope,
  target: TruapiPortTarget,
  parentOrigin: string,
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
    if (
      event.source !== target ||
      event.origin !== parentOrigin ||
      object(event.data)?.type !== "truapi-init"
    ) {
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
  target.postMessage({ type: "truapi-ready" }, parentOrigin);
  return promise;
}

const HOST_FRAME_RETRY_DELAY_MS = 16;
const MAX_HOST_FRAME_RETRIES = 64;

export interface HostFrameResponseTarget {
  postMessage(message: unknown, transfer: Transferable[]): void;
}

export interface HostFrameResponseQueueOptions {
  maxResponses?: number;
  maxBytes?: number;
  retryDelayMs?: number;
  maxRetries?: number;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (timer: number) => void;
}

interface HostFrameResponseEntry {
  bytes: Uint8Array<ArrayBuffer>;
  retries: number;
  seq: number;
}

// The canonical worker bounds its internal host-frame response queue and
// acknowledges every sequenced response with a synchronous
// `host-frame-response-accepted` or nonfatal `host-frame-response-rejected`
// ack echoing the delivery's `seq`. This queue attaches a fresh monotonically
// increasing sequence to every post (retries included), dequeues only on the
// matching accepted ack, retries rejected responses in their original order
// on a paced timer, and consumes mismatched or late acks as no-ops. `fail`
// fires only on protocol violations or exhausted retries.
export class HostFrameResponseQueue {
  private readonly target: HostFrameResponseTarget;
  private readonly fail: (error: Error) => void;
  private readonly maxResponses: number;
  private readonly maxBytes: number;
  private readonly retryDelayMs: number;
  private readonly maxRetries: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => number;
  private readonly clearTimer: (timer: number) => void;
  private readonly queue: HostFrameResponseEntry[] = [];
  private queuedBytes = 0;
  private inFlight: HostFrameResponseEntry | null = null;
  private retryTimer: number | null = null;
  private nextSeq = 1;
  private started = false;
  private closed = false;

  constructor(
    target: HostFrameResponseTarget,
    fail: (error: Error) => void,
    options: HostFrameResponseQueueOptions = {},
  ) {
    this.target = target;
    this.fail = fail;
    this.maxResponses = options.maxResponses ?? MAX_PENDING_HOST_FRAMES;
    this.maxBytes = options.maxBytes ?? MAX_PENDING_HOST_FRAME_BYTES;
    this.retryDelayMs = options.retryDelayMs ?? HOST_FRAME_RETRY_DELAY_MS;
    this.maxRetries = options.maxRetries ?? MAX_HOST_FRAME_RETRIES;
    this.setTimer =
      options.setTimer ??
      ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.clearTimer =
      options.clearTimer ??
      ((timer) => {
        globalThis.clearTimeout(timer);
      });
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get pendingBytes(): number {
    return this.queuedBytes;
  }

  enqueue(value: Uint8Array): void {
    if (this.closed) {
      return;
    }
    if (
      this.queue.length >= this.maxResponses ||
      this.queuedBytes + value.byteLength > this.maxBytes
    ) {
      this.abort(new Error("Host-frame response queue overflow"));
      return;
    }
    this.queue.push({ bytes: ownedBytes(value), retries: 0, seq: 0 });
    this.queuedBytes += value.byteLength;
    this.pump();
  }

  // The worker only accepts host-frame responses once it reported `ready`.
  start(): void {
    if (this.started || this.closed) {
      return;
    }
    this.started = true;
    this.pump();
  }

  // Returns true when the message was a delivery ack consumed by the queue.
  handleMessage(message: Record<string, unknown> | null): boolean {
    const type = message?.type;
    if (this.closed || typeof type !== "string") {
      return false;
    }
    if (type === "host-frame-response-accepted") {
      const entry = this.inFlight;
      if (entry !== null && message?.seq === entry.seq) {
        this.inFlight = null;
        this.queue.shift();
        this.queuedBytes -= entry.bytes.byteLength;
        this.pump();
      }
      // A mismatched ack belongs to a superseded delivery; the retained
      // response stays owned by the current in-flight sequence.
      return true;
    }
    if (type === "host-frame-response-rejected") {
      const entry = this.inFlight;
      if (entry === null || message?.seq !== entry.seq) {
        // A late rejection for a sequence that already settled: the retained
        // response is neither dropped nor re-posted.
        return true;
      }
      if (message.reason !== "queue-full") {
        this.abort(
          new Error("PolkaVM worker sent an invalid host-frame rejection"),
        );
        return true;
      }
      entry.retries += 1;
      if (entry.retries > this.maxRetries) {
        this.abort(new Error("Host-frame response retry limit exceeded"));
        return true;
      }
      this.inFlight = null;
      this.scheduleRetry();
      return true;
    }
    return false;
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer !== null) {
      this.clearTimer(this.retryTimer);
      this.retryTimer = null;
    }
    this.inFlight = null;
    this.queue.length = 0;
    this.queuedBytes = 0;
  }

  private abort(error: Error): void {
    this.close();
    this.fail(error);
  }

  private pump(): void {
    if (
      !this.started ||
      this.closed ||
      this.inFlight !== null ||
      this.retryTimer !== null ||
      this.queue.length === 0
    ) {
      return;
    }
    const entry = this.queue[0];
    entry.seq = this.nextSeq++;
    this.inFlight = entry;
    const payload = ownedBytes(entry.bytes);
    this.target.postMessage(
      { type: "host-frame-response", bytes: payload, seq: entry.seq },
      [payload.buffer],
    );
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) {
      return;
    }
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      this.pump();
    }, this.retryDelayMs);
  }
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
    `${POLKAVM_RUNTIME_ROOT}/polkavm-browser-runtime.wasm`,
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
  if (type === 6 || type === 14) {
    view.setInt16(2, clamp(x, -32768, 32767), true);
    view.setInt16(4, clamp(y, -32768, 32767), true);
  } else {
    view.setUint16(2, clamp(x, 0, 65535), true);
    view.setUint16(4, clamp(y, 0, 65535), true);
  }
  return bytes;
}

const MAX_TEXT_INPUT_BYTES = 4 * 1024;
const TEXT_CHUNK_BYTES = 6;
const TEXT_CHUNK_START = 0x40;
const TEXT_CHUNK_END = 0x80;

export function encodedTextInput(type: 8 | 9 | 10, text: string): Uint8Array[] {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength > MAX_TEXT_INPUT_BYTES) {
    return [];
  }
  const records: Uint8Array[] = [];
  let offset = 0;
  do {
    let end = Math.min(offset + TEXT_CHUNK_BYTES, encoded.byteLength);
    while (
      end > offset &&
      end < encoded.byteLength &&
      (encoded[end] & 0xc0) === 0x80
    ) {
      end -= 1;
    }
    const length = end - offset;
    const record = new Uint8Array(8);
    record[0] = type;
    record[1] =
      length |
      (offset === 0 ? TEXT_CHUNK_START : 0) |
      (end === encoded.byteLength ? TEXT_CHUNK_END : 0);
    record.set(encoded.subarray(offset, end), 2);
    records.push(record);
    offset = end;
  } while (offset < encoded.byteLength);
  return records;
}

const MOTION_SAMPLE_BYTES = 48;
const MOTION_FLAG_ACCELERATION = 1;
const MOTION_FLAG_ROTATION = 2;
const MOTION_FLAG_POINTER_EMULATED = 4;
const POINTER_ROTATION_DEGREES_PER_PIXEL = 0.15;
const MAX_POINTER_ROTATION_RATE = 720;

export interface MotionSampleValues {
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

export function encodedMotionSample(sample: MotionSampleValues): Uint8Array {
  if (
    !Number.isInteger(sample.flags) ||
    sample.flags <= 0 ||
    (sample.flags & ~7) !== 0 ||
    ((sample.flags & MOTION_FLAG_POINTER_EMULATED) !== 0 &&
      (sample.flags & MOTION_FLAG_ROTATION) === 0) ||
    !Number.isInteger(sample.sequence) ||
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
  bytes.set([0x50, 0x4d, 0x4f, 0x31]);
  view.setUint16(4, 1, true);
  view.setUint16(6, sample.flags, true);
  view.setUint32(8, MOTION_SAMPLE_BYTES, true);
  view.setUint32(12, sample.sequence, true);
  view.setFloat64(16, sample.timestampMs, true);
  for (const [offset, value] of [
    [24, sample.accelerationX],
    [28, sample.accelerationY],
    [32, sample.accelerationZ],
    [36, sample.rotationAlpha],
    [40, sample.rotationBeta],
    [44, sample.rotationGamma],
  ] as const) {
    view.setFloat32(offset, value, true);
  }
  return bytes;
}

export function encodedPointerMotionSample(
  deltaX: number,
  deltaY: number,
  elapsedMs: number,
  sequence: number,
  timestampMs: number,
): Uint8Array {
  if (
    !Number.isFinite(deltaX) ||
    !Number.isFinite(deltaY) ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= 0
  ) {
    throw new Error("invalid pointer motion sample");
  }
  const degreesPerSecond = (delta: number): number =>
    Math.max(
      -MAX_POINTER_ROTATION_RATE,
      Math.min(
        MAX_POINTER_ROTATION_RATE,
        (delta * POINTER_ROTATION_DEGREES_PER_PIXEL * 1_000) / elapsedMs,
      ),
    );
  return encodedMotionSample({
    flags: MOTION_FLAG_ROTATION | MOTION_FLAG_POINTER_EMULATED,
    sequence,
    timestampMs,
    accelerationX: 0,
    accelerationY: 0,
    accelerationZ: 0,
    rotationAlpha: 0,
    rotationBeta: degreesPerSecond(deltaY),
    rotationGamma: degreesPerSecond(deltaX),
  });
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
  metrics: HTMLDetailsElement;
  metricsSummary: HTMLElement;
  metricsDetails: HTMLElement;
} {
  const style = document.createElement("style");
  style.textContent = `
    html,body{width:100%;height:100%;margin:0;background:#050505;color:#fff;overflow:hidden;overscroll-behavior:none}
    #dotli-polkavm-shell{width:100%;height:100%;display:grid;place-items:center;position:relative;overflow:hidden;background:#050505}
    #dotli-polkavm-canvas{position:absolute;inset:0;display:block;width:100%;height:100%;min-width:0;min-height:0;image-rendering:pixelated;outline:none;touch-action:none;overscroll-behavior:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
    .dotli-polkavm-overlay{position:absolute;left:12px;background:#090b0de8;border:1px solid #ffffff2b;border-radius:4px;font:11px/1.35 ui-monospace,monospace;color:#f5f5f5}
    #dotli-polkavm-status{top:12px;padding:5px 8px;pointer-events:none}
    #dotli-polkavm-status:empty{display:none}
    #dotli-polkavm-metrics{top:12px;max-width:min(460px,calc(100vw - 24px));overflow:hidden;pointer-events:auto}
    #dotli-polkavm-metrics[hidden]{display:none}
    #dotli-polkavm-metrics summary{padding:6px 9px;cursor:pointer;white-space:nowrap;font-weight:600;user-select:none}
    #dotli-polkavm-metrics pre{margin:0;padding:7px 9px;border-top:1px solid #ffffff1f;white-space:pre-wrap;color:#c9ced3;font:inherit;font-weight:400}
    #dotli-polkavm-controls{position:absolute;right:12px;bottom:12px;max-width:min(480px,70vw);font:11px/1.4 ui-monospace,monospace;color:#ddd;text-align:right}
  `;
  const shell = document.createElement("main");
  shell.id = "dotli-polkavm-shell";
  const canvas = document.createElement("canvas");
  canvas.id = "dotli-polkavm-canvas";
  canvas.tabIndex = 0;
  const status = document.createElement("div");
  status.id = "dotli-polkavm-status";
  status.className = "dotli-polkavm-overlay";
  status.textContent = "Translating PolkaVM application…";
  const metrics = document.createElement("details");
  metrics.id = "dotli-polkavm-metrics";
  metrics.className = "dotli-polkavm-overlay";
  metrics.hidden = true;
  const metricsSummary = document.createElement("summary");
  const metricsDetails = document.createElement("pre");
  metrics.append(metricsSummary, metricsDetails);
  const controlText = document.createElement("div");
  controlText.id = "dotli-polkavm-controls";
  controlText.textContent = controls.join(" · ");
  shell.append(canvas, status, metrics, controlText);
  document.head.append(style);
  document.body.replaceChildren(shell);
  return { canvas, status, metrics, metricsSummary, metricsDetails };
}

function installInput(
  canvas: HTMLCanvasElement,
  webGpu: WebGpuBridge | null,
  graphicsProfile: GraphicsProfile,
  inputFeatures: readonly string[],
  send: (bytes: Uint8Array) => void,
  sendMotion: (bytes: Uint8Array) => void,
  sendMotionStatus: (availability: 0 | 1 | 2) => void,
  sendPointerCaptureState: (active: boolean) => void,
  pointerCaptureRequested: () => boolean,
  motionRequested: () => boolean,
  parentOrigin: string | null,
  resumeAudio: () => void,
): {
  applyUiOutput: (output: UiPlatformOutput) => void;
  cleanup: () => void;
  sendSurfaceMetrics: () => void;
  setPointerCaptureRequest: (capture: boolean) => void;
} {
  const pressed = new Set<number>();
  const inputFeatureSet = new Set(inputFeatures);
  const textInput =
    inputFeatureSet.has("text") || inputFeatureSet.has("ime")
      ? document.createElement("textarea")
      : null;
  if (textInput !== null) {
    textInput.tabIndex = -1;
    textInput.spellcheck = false;
    textInput.setAttribute("autocomplete", "off");
    textInput.setAttribute("autocapitalize", "off");
    textInput.style.cssText =
      "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.append(textInput);
  }
  let composing = false;
  let suppressCommittedInput = false;
  // An app that requires committed text gets the hidden text surface from
  // the first click; ui-output refines this once the guest reports cursor
  // context. Without the default, a text-requiring guest that never emits
  // ui-output (the Zed editor) could not receive typing at all.
  let wantsTextInput = inputFeatureSet.has("text");
  let reportedFocused = false;
  let firstMoveAfterPointerLock = false;
  let relativeX = 0;
  let relativeY = 0;
  let relativeFrame: number | null = null;
  let pointerCaptureArmed = false;
  const pointerCaptureSupported =
    typeof canvas.requestPointerLock === "function" &&
    typeof document.exitPointerLock === "function";
  canvas.dataset.polkavmPointerCaptureArmed = "false";
  canvas.dataset.polkavmPointerCaptured = "false";
  // The ABI carries one pointer, and a touch gesture that leaves the canvas or
  // is claimed by the browser must still deliver its release, or the guest keeps
  // a phantom button down.
  let activePointer: { id: number; button: number } | null = null;
  let motionSequence = 0;
  let motionX = 0;
  let motionY = 0;
  let motionFrame: number | null = null;
  let motionWindowStarted = performance.now();
  let previousPointer: [number, number] | null = null;
  let motionPermissionRequested = false;
  const nextMotionSequence = (): number => {
    motionSequence = motionSequence === 0xffffffff ? 1 : motionSequence + 1;
    return motionSequence;
  };
  const flushPointerMotion = (now: number): void => {
    motionFrame = null;
    const x = motionX;
    const y = motionY;
    motionX = 0;
    motionY = 0;
    if (x === 0 && y === 0) {
      return;
    }
    const elapsedMs = Math.max(1, now - motionWindowStarted);
    motionWindowStarted = now;
    sendMotion(
      encodedPointerMotionSample(x, y, elapsedMs, nextMotionSequence(), now),
    );
  };
  const queuePointerMotion = (x: number, y: number): void => {
    if (!motionRequested()) {
      return;
    }
    motionX += x;
    motionY += y;
    motionFrame ??= window.requestAnimationFrame(flushPointerMotion);
  };
  const requestDeviceMotionPermission = (): void => {
    if (
      !motionRequested() ||
      motionPermissionRequested ||
      typeof DeviceMotionEvent === "undefined"
    ) {
      return;
    }
    motionPermissionRequested = true;
    const constructor = DeviceMotionEvent as typeof DeviceMotionEvent & {
      requestPermission?: () => Promise<"granted" | "denied">;
    };
    if (typeof constructor.requestPermission === "function") {
      void constructor
        .requestPermission()
        .then((permission) => {
          sendMotionStatus(
            permission === "granted" || typeof PointerEvent !== "undefined"
              ? 1
              : 2,
          );
        })
        .catch(() => {
          motionPermissionRequested = false;
          sendMotionStatus(typeof PointerEvent !== "undefined" ? 1 : 2);
        });
    } else {
      sendMotionStatus(1);
    }
  };
  const deviceMotion = (event: DeviceMotionEvent): void => {
    if (!motionRequested()) {
      return;
    }
    const acceleration = event.accelerationIncludingGravity;
    const rotation = event.rotationRate;
    const accelerationValues = [
      acceleration?.x,
      acceleration?.y,
      acceleration?.z,
    ];
    const rotationValues = [rotation?.alpha, rotation?.beta, rotation?.gamma];
    const hasAcceleration = accelerationValues.every(
      (value) => typeof value === "number" && Number.isFinite(value),
    );
    const hasRotation = rotationValues.every(
      (value) => typeof value === "number" && Number.isFinite(value),
    );
    if (!hasAcceleration && !hasRotation) {
      return;
    }
    sendMotion(
      encodedMotionSample({
        flags:
          (hasAcceleration ? MOTION_FLAG_ACCELERATION : 0) |
          (hasRotation ? MOTION_FLAG_ROTATION : 0),
        sequence: nextMotionSequence(),
        timestampMs: performance.now(),
        accelerationX: hasAcceleration ? (acceleration?.x ?? 0) : 0,
        accelerationY: hasAcceleration ? (acceleration?.y ?? 0) : 0,
        accelerationZ: hasAcceleration ? (acceleration?.z ?? 0) : 0,
        rotationAlpha: hasRotation ? (rotation?.alpha ?? 0) : 0,
        rotationBeta: hasRotation ? (rotation?.beta ?? 0) : 0,
        rotationGamma: hasRotation ? (rotation?.gamma ?? 0) : 0,
      }),
    );
  };
  const flushRelativePointer = (): void => {
    relativeFrame = null;
    const x = relativeX;
    const y = relativeY;
    relativeX = 0;
    relativeY = 0;
    if (x !== 0 || y !== 0) {
      send(encodedInput(6, 0, x, y));
      queuePointerMotion(x, y);
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
  const clearPointerMotion = (): void => {
    if (relativeFrame !== null) {
      window.cancelAnimationFrame(relativeFrame);
      relativeFrame = null;
    }
    relativeX = 0;
    relativeY = 0;
    if (motionFrame !== null) {
      window.cancelAnimationFrame(motionFrame);
      motionFrame = null;
    }
    motionX = 0;
    motionY = 0;
    motionWindowStarted = performance.now();
    previousPointer = null;
  };
  const releasePointerLock = (): void => {
    if (document.pointerLockElement !== canvas) {
      return;
    }
    try {
      document.exitPointerLock();
    } catch (error) {
      console.warn(
        `Could not release PolkaVM pointer lock: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const pointerLockChanged = (): void => {
    clearPointerMotion();
    const active = document.pointerLockElement === canvas;
    firstMoveAfterPointerLock = active;
    if (active) {
      pointerCaptureArmed = false;
    }
    if (pointerCaptureRequested()) {
      sendPointerCaptureState(active);
    }
    canvas.dataset.polkavmPointerCaptureArmed = pointerCaptureArmed
      ? "true"
      : "false";
    canvas.dataset.polkavmPointerCaptured = active ? "true" : "false";
  };
  const canvasPosition = (event: PointerEvent): [number, number] => {
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return [0, 0];
    }
    return [
      ((event.clientX - bounds.left) *
        (webGpu?.physicalWidth ?? canvas.width)) /
        bounds.width,
      ((event.clientY - bounds.top) *
        (webGpu?.physicalHeight ?? canvas.height)) /
        bounds.height,
    ];
  };
  const sendTextRecords = (type: 8 | 9 | 10, text: string): void => {
    for (const record of encodedTextInput(type, text)) {
      send(record);
    }
  };
  const syncFocus = (): void => {
    const focused =
      document.activeElement === canvas ||
      (textInput !== null && document.activeElement === textInput);
    if (focused === reportedFocused) {
      return;
    }
    reportedFocused = focused;
    if (!focused) {
      if (composing && inputFeatureSet.has("ime")) {
        send(encodedInput(12, 0));
      }
      composing = false;
    }
    if (inputFeatureSet.has("focus")) {
      send(encodedInput(13, focused ? 1 : 0));
    }
  };
  const focusChanged = (): void => {
    queueMicrotask(syncFocus);
  };
  const beforeInput = (event: InputEvent): void => {
    if (
      !inputFeatureSet.has("text") ||
      composing ||
      event.isComposing ||
      suppressCommittedInput ||
      event.data === null
    ) {
      return;
    }
    sendTextRecords(8, event.data);
    if (event.cancelable) {
      event.preventDefault();
    }
  };
  const input = (): void => {
    if (!composing && textInput !== null) {
      textInput.value = "";
    }
  };
  const compositionStart = (): void => {
    composing = true;
    if (inputFeatureSet.has("ime")) {
      send(encodedInput(11, 0));
    }
  };
  const compositionUpdate = (event: CompositionEvent): void => {
    if (inputFeatureSet.has("ime")) {
      sendTextRecords(9, event.data);
    }
  };
  const compositionEnd = (event: CompositionEvent): void => {
    composing = false;
    suppressCommittedInput = true;
    queueMicrotask(() => {
      suppressCommittedInput = false;
    });
    if (inputFeatureSet.has("ime")) {
      sendTextRecords(10, event.data);
      send(encodedInput(12, 0));
    } else if (inputFeatureSet.has("text")) {
      sendTextRecords(8, event.data);
    }
    if (textInput !== null) {
      textInput.value = "";
    }
  };
  const wheel = (event: WheelEvent): void => {
    event.preventDefault();
    const scale =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? Math.max(1, canvas.clientHeight)
          : 1;
    send(encodedInput(14, 0, event.deltaX * scale, event.deltaY * scale));
  };
  const keydown = (event: KeyboardEvent): void => {
    requestDeviceMotionPermission();
    if (event.code === "Escape" && document.pointerLockElement === canvas) {
      event.preventDefault();
      const code = keyCodes.Escape;
      send(encodedInput(1, code));
      window.setTimeout(() => {
        send(encodedInput(2, code));
      }, 50);
      releasePointerLock();
      return;
    }
    if (!(event.code in keyCodes) || event.repeat) {
      return;
    }
    const code = keyCodes[event.code];
    if (pressed.has(code)) {
      return;
    }
    if (event.isTrusted && parentOrigin !== null) {
      window.parent.postMessage(
        { type: "dotli:polkavm-user-activation" },
        parentOrigin,
      );
    }
    if (
      textInput === null ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.code === "Tab"
    ) {
      event.preventDefault();
    }
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
    if (!event.isPrimary) {
      return;
    }
    if (document.pointerLockElement === canvas) {
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
      return;
    }
    const [x, y] = canvasPosition(event);
    send(encodedInput(5, 0, x, y));
    if (previousPointer !== null) {
      queuePointerMotion(
        event.clientX - previousPointer[0],
        event.clientY - previousPointer[1],
      );
    }
    previousPointer = [event.clientX, event.clientY];
  };
  const down = (event: PointerEvent): void => {
    if (!event.isPrimary) {
      return;
    }
    requestDeviceMotionPermission();
    if (
      event.isTrusted &&
      event.button in pointerButtons &&
      parentOrigin !== null
    ) {
      window.parent.postMessage(
        { type: "dotli:polkavm-user-activation" },
        parentOrigin,
      );
    }
    previousPointer = [event.clientX, event.clientY];
    (wantsTextInput && textInput !== null ? textInput : canvas).focus({
      preventScroll: true,
    });
    move(event);
    pointer(event, 3);
    if (
      pointerCaptureArmed &&
      event.button === 0 &&
      typeof canvas.requestPointerLock === "function" &&
      document.pointerLockElement !== canvas
    ) {
      void canvas.requestPointerLock().catch(() => undefined);
    }
    if (document.pointerLockElement !== canvas) {
      activePointer = { id: event.pointerId, button: event.button };
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch (error) {
        // Capture is an optimisation: a browser that refuses it still delivers
        // events while the pointer stays over the canvas.
        console.warn(
          `Could not capture the PolkaVM pointer: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };
  const releaseCapturedPointer = (pointerId: number): void => {
    try {
      if (canvas.hasPointerCapture(pointerId)) {
        canvas.releasePointerCapture(pointerId);
      }
    } catch (error) {
      console.warn(
        `Could not release the PolkaVM pointer capture: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const up = (event: PointerEvent): void => {
    if (!event.isPrimary) {
      return;
    }
    releaseCapturedPointer(event.pointerId);
    activePointer = null;
    previousPointer = null;
    pointer(event, 4);
  };
  // Chrome cancels the pointer stream when it claims a gesture, and iOS cancels
  // on system edge gestures. Neither delivers `pointerup`, so synthesise the
  // release the guest is waiting for.
  const cancel = (event: PointerEvent): void => {
    if (activePointer?.id !== event.pointerId) {
      return;
    }
    const button = activePointer.button;
    releaseCapturedPointer(event.pointerId);
    activePointer = null;
    previousPointer = null;
    const [x, y] = canvasPosition(event);
    send(encodedInput(4, pointerButtons[button] ?? 1, x, y));
  };
  const contextmenu = (event: MouseEvent): void => {
    event.preventDefault();
  };
  const surfaceScale = (): number =>
    Math.max(1 / 32, Math.min(4, window.devicePixelRatio || 1));
  const sendSurfaceMetrics = (): void => {
    if (graphicsProfile !== "tri2d") {
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    const scale = surfaceScale();
    const width = clamp(bounds.width * scale, 1, 4_096);
    const height = clamp(bounds.height * scale, 1, 4_096);
    send(encodedInput(7, clamp(scale * 32, 1, 128), width, height));
  };
  const applyUiOutput = (output: UiPlatformOutput): void => {
    canvas.style.cursor = output.cursorIcon;
    wantsTextInput = output.mutableTextUnderCursor || output.ime !== null;
    if (textInput === null) {
      return;
    }
    if (output.ime === null) {
      if (document.activeElement === textInput) {
        canvas.focus({ preventScroll: true });
      }
      return;
    }

    const bounds = canvas.getBoundingClientRect();
    const logicalWidth = canvas.width / surfaceScale();
    const logicalHeight = canvas.height / surfaceScale();
    const scaleX = bounds.width / Math.max(1, logicalWidth);
    const scaleY = bounds.height / Math.max(1, logicalHeight);
    const cursor = output.ime.cursorRect;
    const x = bounds.left + ((cursor[0] + cursor[2]) / 2) * scaleX;
    const y = bounds.top + ((cursor[1] + cursor[3]) / 2) * scaleY;
    textInput.style.left = `${String(Math.max(bounds.left, Math.min(bounds.right - 1, x)))}px`;
    textInput.style.top = `${String(Math.max(bounds.top, Math.min(bounds.bottom - 1, y)))}px`;
    if (document.activeElement === canvas) {
      textInput.focus({ preventScroll: true });
    }
  };
  const resizeObserver =
    graphicsProfile === "tri2d"
      ? new ResizeObserver(() => {
          sendSurfaceMetrics();
        })
      : null;
  resizeObserver?.observe(canvas);
  canvas.addEventListener("focus", focusChanged);
  canvas.addEventListener("blur", focusChanged);
  if (textInput !== null) {
    textInput.addEventListener("beforeinput", beforeInput);
    textInput.addEventListener("input", input);
    textInput.addEventListener("compositionstart", compositionStart);
    textInput.addEventListener("compositionupdate", compositionUpdate);
    textInput.addEventListener("compositionend", compositionEnd);
    textInput.addEventListener("focus", focusChanged);
    textInput.addEventListener("blur", focusChanged);
  }
  if (inputFeatureSet.has("wheel")) {
    canvas.addEventListener("wheel", wheel, { passive: false });
  }
  document.addEventListener("pointerlockchange", pointerLockChanged);
  window.addEventListener("keydown", keydown);
  window.addEventListener("keyup", keyup);
  window.addEventListener("devicemotion", deviceMotion);
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointercancel", cancel);
  canvas.addEventListener("contextmenu", contextmenu);
  return {
    applyUiOutput,
    sendSurfaceMetrics,
    setPointerCaptureRequest: (capture) => {
      pointerCaptureArmed =
        capture &&
        pointerCaptureSupported &&
        document.pointerLockElement !== canvas;
      canvas.dataset.polkavmPointerCaptureArmed = pointerCaptureArmed
        ? "true"
        : "false";
      if (!capture) {
        releasePointerLock();
      }
    },
    cleanup: () => {
      resizeObserver?.disconnect();
      if (
        document.activeElement === canvas ||
        (textInput !== null && document.activeElement === textInput)
      ) {
        (document.activeElement as HTMLElement).blur();
      }
      pointerCaptureArmed = false;
      canvas.dataset.polkavmPointerCaptureArmed = "false";
      canvas.dataset.polkavmPointerCaptured = "false";
      releasePointerLock();
      clearPointerMotion();
      document.removeEventListener("pointerlockchange", pointerLockChanged);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("devicemotion", deviceMotion);
      canvas.removeEventListener("focus", focusChanged);
      canvas.removeEventListener("blur", focusChanged);
      if (textInput !== null) {
        textInput.removeEventListener("beforeinput", beforeInput);
        textInput.removeEventListener("input", input);
        textInput.removeEventListener("compositionstart", compositionStart);
        textInput.removeEventListener("compositionupdate", compositionUpdate);
        textInput.removeEventListener("compositionend", compositionEnd);
        textInput.removeEventListener("focus", focusChanged);
        textInput.removeEventListener("blur", focusChanged);
        textInput.remove();
      }
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("contextmenu", contextmenu);
    },
  };
}

export async function runPolkaVmApplication(
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
    new URLSearchParams(location.search).get("polkavmMode") === "interpreter";

  const started = performance.now();
  if (
    descriptor.inputFeatures.includes("motion") &&
    typeof PointerEvent === "undefined" &&
    typeof DeviceMotionEvent === "undefined"
  ) {
    throw new Error("required motion input is unavailable");
  }
  const {
    canvas,
    status,
    metrics: metricsElement,
    metricsSummary,
    metricsDetails,
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
  canvas.dataset.polkavmProfile = descriptor.graphicsProfile;

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

  const parentOrigin = expectedPolkaVmParentOrigin(
    location.hostname,
    location.protocol,
    location.port,
  );
  if (parentOrigin === null) {
    throw new Error("cannot authenticate the PolkaVM host origin");
  }
  const {
    promise: startedPromise,
    resolve: resolveStarted,
    reject: rejectStarted,
  } = Promise.withResolvers<undefined>();
  const hostFramePort = await waitForTruapiPort(
    window,
    window.parent,
    parentOrigin,
  );
  const worker = new Worker(`${POLKAVM_RUNTIME_ROOT}/polkavm-worker.js`);
  const closeHostFramePort = (): void => {
    hostFramePort.onmessage = null;
    hostFramePort.onmessageerror = null;
    hostFramePort.close();
    if (window.__HOST_API_PORT__ === hostFramePort) {
      delete window.__HOST_API_PORT__;
    }
  };
  canvas.dataset.polkavmHostFrameRequests = "0";
  canvas.dataset.polkavmHostFrameResponses = "0";
  const failHostFrame = (error: Error): void => {
    status.textContent = error.message;
    rejectStarted(error);
    worker.postMessage({ type: "stop" });
    worker.terminate();
    closeHostFramePort();
  };
  const hostFrameQueue = new HostFrameResponseQueue(worker, failHostFrame);
  hostFramePort.onmessage = (event: MessageEvent<unknown>): void => {
    if (
      !(event.data instanceof Uint8Array) ||
      event.data.byteLength === 0 ||
      event.data.byteLength > MAX_HOST_FRAME_BYTES
    ) {
      failHostFrame(new Error("Host returned an invalid host frame"));
      return;
    }
    canvas.dataset.polkavmHostFrameResponses = String(
      Number(canvas.dataset.polkavmHostFrameResponses) + 1,
    );
    hostFrameQueue.enqueue(event.data);
  };
  hostFramePort.onmessageerror = () => {
    failHostFrame(new Error("Host port could not decode a host frame"));
  };
  hostFramePort.start();
  let audioContext: AudioContext | null = null;
  let audioCursor = 0;
  let firstFrame = false;
  let frameWindowStarted = performance.now();
  let frameWindowCount = 0;
  const polkavmMetrics: PolkaVmMetrics = {
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
  window.__dotliPolkaVmMetrics = polkavmMetrics;

  const updateMetrics = (): void => {
    const display = formatPolkaVmMetrics(polkavmMetrics);
    metricsSummary.textContent = display.summary;
    metricsDetails.textContent = display.details;
    canvas.dataset.polkavmBackend = polkavmMetrics.backend;
    canvas.dataset.polkavmCacheHit = String(polkavmMetrics.cacheHit);
    canvas.dataset.polkavmTranslationMs = String(polkavmMetrics.translationMs);
    canvas.dataset.polkavmCompilationMs = String(polkavmMetrics.compilationMs);
    canvas.dataset.polkavmStartupMs = String(polkavmMetrics.startupMs);
    canvas.dataset.polkavmStartupStage = polkavmMetrics.startupStage;
    canvas.dataset.polkavmFirstFrameMs = String(polkavmMetrics.firstFrameMs);
    canvas.dataset.polkavmFrames = String(polkavmMetrics.frames);
    canvas.dataset.polkavmFps = String(polkavmMetrics.fps);
    canvas.dataset.polkavmUpdates = String(polkavmMetrics.updates);
    canvas.dataset.polkavmUpdateP50Ms = String(polkavmMetrics.updateP50Ms);
    canvas.dataset.polkavmUpdateP95Ms = String(polkavmMetrics.updateP95Ms);
    canvas.dataset.polkavmUpdateMaxMs = String(polkavmMetrics.updateMaxMs);
    canvas.dataset.polkavmAudioChunks = String(polkavmMetrics.audioChunks);
    canvas.dataset.polkavmAudioSamples = String(polkavmMetrics.audioSamples);
  };
  const setStartupStage = (stage: string): void => {
    if (firstFrame) {
      return;
    }
    polkavmMetrics.startupStage = stage;
    status.textContent = `PolkaVM startup: ${stage.replaceAll("-", " ")}…`;
    updateMetrics();
  };
  const presentedFrame = (): void => {
    polkavmMetrics.frames++;
    canvas.dataset.polkavmFrames = String(polkavmMetrics.frames);
    frameWindowCount++;
    const now = performance.now();
    if (now - frameWindowStarted >= 500) {
      polkavmMetrics.fps =
        (frameWindowCount * 1000) / (now - frameWindowStarted);
      frameWindowStarted = now;
      frameWindowCount = 0;
      updateMetrics();
    }
    if (!firstFrame) {
      firstFrame = true;
      polkavmMetrics.firstFrameMs = now - started;
      polkavmMetrics.startupStage = "first-frame";
      status.textContent = "";
      metricsElement.hidden = false;
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
    polkavmMetrics.audioChunks++;
    polkavmMetrics.audioSamples += message.samples.byteLength / 2;
    canvas.dataset.polkavmAudioChunks = String(polkavmMetrics.audioChunks);
    canvas.dataset.polkavmAudioSamples = String(polkavmMetrics.audioSamples);
    if (
      canvas.dataset.polkavmAudioNonzero !== "true" &&
      message.samples.some((byte) => byte !== 0)
    ) {
      canvas.dataset.polkavmAudioNonzero = "true";
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

  let startTimeoutMs = forceInterpreter
    ? INTERPRETER_START_TIMEOUT_MS
    : START_TIMEOUT_MS;
  const onStartTimeout = (): void => {
    const label =
      forceInterpreter || polkavmMetrics.backend === "interpreter"
        ? "PolkaVM interpreter"
        : "PolkaVM application";
    rejectStarted(
      new Error(
        `${label} did not present a frame within ${String(startTimeoutMs / 1000)}s (last stage: ${polkavmMetrics.startupStage})`,
      ),
    );
  };
  let timer = window.setTimeout(onStartTimeout, startTimeoutMs);
  let webGpu: WebGpuBridge | null = null;
  let gpuCapabilities: Uint8Array | null = null;
  if (
    descriptor.graphicsProfile === "webgpu-raster" ||
    descriptor.graphicsProfile === "webgpu"
  ) {
    if (descriptor.webGpuRequirements === null) {
      throw new Error("WebGPU requirements are missing");
    }
    webGpu = new WebGpuBridge(canvas, descriptor.webGpuRequirements, {
      capabilities: (bytes) => {
        const capabilities = ownedBytes(bytes);
        worker.postMessage({ type: "gpu-capabilities", bytes: capabilities }, [
          capabilities.buffer,
        ]);
      },
      event: (bytes) => {
        worker.postMessage({ type: "gpu-event", bytes }, [bytes.buffer]);
      },
      presented: presentedFrame,
      error: (error) => {
        status.textContent = error.message;
        rejectStarted(error);
      },
    });
    try {
      gpuCapabilities = await webGpu.capabilities;
    } catch (error) {
      webGpu.dispose();
      worker.terminate();
      closeHostFramePort();
      rejectStarted(error);
      return startedPromise;
    }
  }

  let usesMotion = false;
  let usesPointerCapture = false;
  let relayedMotionSequence = 0;
  const sendMotion = (bytes: Uint8Array): void => {
    const flags = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).getUint16(6, true);
    canvas.dataset.polkavmMotionSamples = String(
      Number(canvas.dataset.polkavmMotionSamples ?? 0) + 1,
    );
    canvas.dataset.polkavmMotionSource =
      (flags & MOTION_FLAG_POINTER_EMULATED) !== 0 ? "pointer" : "device";
    worker.postMessage({ type: "motion", bytes }, [bytes.buffer]);
  };
  const onParentMotion = (event: MessageEvent<unknown>): void => {
    if (event.source !== window.parent || event.origin !== parentOrigin) {
      return;
    }
    const message = object(event.data);
    if (
      message?.type === "dotli:polkavm-motion-status" &&
      Number.isInteger(message.availability) &&
      Number(message.availability) >= 0 &&
      Number(message.availability) <= 2
    ) {
      worker.postMessage({
        type: "motion-status",
        availability: Number(message.availability),
      });
      return;
    }
    if (message?.type !== "dotli:polkavm-motion-sample") {
      return;
    }
    const acceleration = object(message.acceleration);
    const rotation = object(message.rotation);
    const accelerationX = acceleration?.x;
    const accelerationY = acceleration?.y;
    const accelerationZ = acceleration?.z;
    const rotationAlpha = rotation?.alpha;
    const rotationBeta = rotation?.beta;
    const rotationGamma = rotation?.gamma;
    const finite = (value: unknown): value is number =>
      typeof value === "number" && Number.isFinite(value);
    const hasAcceleration =
      finite(accelerationX) && finite(accelerationY) && finite(accelerationZ);
    const hasRotation =
      finite(rotationAlpha) && finite(rotationBeta) && finite(rotationGamma);
    if (!hasAcceleration && !hasRotation) {
      return;
    }
    relayedMotionSequence =
      relayedMotionSequence === 0xffffffff ? 1 : relayedMotionSequence + 1;
    sendMotion(
      encodedMotionSample({
        flags:
          (hasAcceleration ? MOTION_FLAG_ACCELERATION : 0) |
          (hasRotation ? MOTION_FLAG_ROTATION : 0),
        sequence: relayedMotionSequence,
        timestampMs: finite(message.timestampMs)
          ? message.timestampMs
          : performance.now(),
        accelerationX: finite(accelerationX) ? accelerationX : 0,
        accelerationY: finite(accelerationY) ? accelerationY : 0,
        accelerationZ: finite(accelerationZ) ? accelerationZ : 0,
        rotationAlpha: finite(rotationAlpha) ? rotationAlpha : 0,
        rotationBeta: finite(rotationBeta) ? rotationBeta : 0,
        rotationGamma: finite(rotationGamma) ? rotationGamma : 0,
      }),
    );
  };
  window.addEventListener("message", onParentMotion);
  const {
    applyUiOutput,
    cleanup: cleanupInput,
    sendSurfaceMetrics,
    setPointerCaptureRequest,
  } = installInput(
    canvas,
    webGpu,
    descriptor.graphicsProfile,
    descriptor.inputFeatures,
    (bytes) => {
      worker.postMessage({ type: "input", bytes }, [bytes.buffer]);
    },
    sendMotion,
    (availability) => {
      worker.postMessage({ type: "motion-status", availability });
    },
    (active) => {
      worker.postMessage({ type: "pointer-capture-state", active });
    },
    () => usesPointerCapture,
    () => usesMotion,
    parentOrigin,
    resumeAudio,
  );
  let stopped = false;
  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    cleanupInput();
    window.removeEventListener("message", onParentMotion);
    tri2d?.dispose();
    worker.postMessage({ type: "stop" });
    worker.terminate();
    webGpu?.dispose();
    void audioContext?.close();
    closeHostFramePort();
    hostFrameQueue.close();
  };
  window.addEventListener("pagehide", stop, { once: true });
  // Mobile browsers may discard the worker-owned GPU device while the screen
  // is locked. Reload only this product frame on wake: that recreates the
  // OffscreenCanvas, worker, and input listeners while the top-level motion
  // permission relay remains active.
  if (
    descriptor.graphicsProfile === "webgpu-raster" ||
    descriptor.graphicsProfile === "webgpu"
  ) {
    let wasHidden = document.visibilityState === "hidden";
    let reloadRequested = false;
    const reloadAfterWake = (): void => {
      if (reloadRequested) {
        return;
      }
      reloadRequested = true;
      location.reload();
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        wasHidden = true;
        return;
      }
      if (shouldReloadAfterWake(wasHidden, document.visibilityState, false)) {
        reloadAfterWake();
      }
    });
    window.addEventListener("pageshow", (event) => {
      if (
        shouldReloadAfterWake(
          wasHidden,
          document.visibilityState,
          event.persisted,
        )
      ) {
        reloadAfterWake();
      }
    });
  }

  let translationStorePromise: Promise<void> = Promise.resolve();
  worker.onmessage = async (event: MessageEvent<unknown>): Promise<void> => {
    const message = object(event.data);
    if (hostFrameQueue.handleMessage(message)) {
      return;
    }
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
          translationStorePromise = storeTranslation(
            cacheKey,
            message.bytes,
          ).catch((error: unknown) => {
            console.warn(
              `PolkaVM translation cache write failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
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
        await translationStorePromise;
        const ready = message as unknown as WorkerReady;
        polkavmMetrics.backend = ready.backend;
        polkavmMetrics.cacheHit = ready.cacheHit === true;
        polkavmMetrics.translationMs = ready.translationMs ?? 0;
        polkavmMetrics.compilationMs = ready.compilationMs ?? 0;
        polkavmMetrics.startupMs = ready.startupMs ?? 0;
        polkavmMetrics.translatedWasmBytes = ready.translatedWasmBytes ?? 0;
        polkavmMetrics.startupStage = "ready";
        status.textContent = `${ready.backend === "compiler" ? "PolkaVM→Wasm JIT" : "PolkaVM interpreter"} ready`;
        canvas.dataset.polkavmReady = "true";
        updateMetrics();
        if (ready.backend === "interpreter" && !forceInterpreter) {
          // Translation fell back to the interpreter, so the compiler start
          // budget no longer applies; re-arm the frame watchdog with the
          // interpreter budget instead of failing a live guest at 30s.
          window.clearTimeout(timer);
          startTimeoutMs = INTERPRETER_START_TIMEOUT_MS;
          timer = window.setTimeout(
            onStartTimeout,
            INTERPRETER_START_TIMEOUT_MS,
          );
        }
        usesMotion = ready.usesMotion === true;
        usesPointerCapture = ready.usesPointerCapture === true;
        if (usesPointerCapture) {
          worker.postMessage({
            type: "pointer-capture-support",
            supported:
              typeof canvas.requestPointerLock === "function" &&
              typeof document.exitPointerLock === "function",
          });
        }
        if (usesMotion) {
          window.parent.postMessage(
            { type: "dotli:polkavm-motion-request" },
            parentOrigin,
          );
        }
        sendSurfaceMetrics();
        hostFrameQueue.start();
        break;
      }
      case "pointer-capture": {
        if (!usesPointerCapture || typeof message.capture !== "boolean") {
          rejectStarted(
            new Error(
              "PolkaVM guest emitted an invalid pointer capture request",
            ),
          );
          return;
        }
        setPointerCaptureRequest(message.capture);
        break;
      }
      case "host-frame-request": {
        const bytes = message.bytes;
        if (
          !(bytes instanceof Uint8Array) ||
          bytes.byteLength === 0 ||
          bytes.byteLength > MAX_HOST_FRAME_BYTES
        ) {
          failHostFrame(
            new Error("PolkaVM guest emitted an invalid host frame"),
          );
          return;
        }
        const request = ownedBytes(bytes);
        canvas.dataset.polkavmHostFrameRequests = String(
          Number(canvas.dataset.polkavmHostFrameRequests) + 1,
        );
        hostFramePort.postMessage(request, [request.buffer]);
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
          canvas.dataset.polkavmTri2dDraws = String(metadata.drawCount);
          canvas.dataset.polkavmTri2dVertices = String(metadata.vertexCount);
          canvas.dataset.polkavmTri2dIndices = String(metadata.indexCount);
          presentedFrame();
        } catch (error) {
          rejectStarted(error);
        }
        break;
      }
      case "ui-output": {
        const output = validatedUiPlatformOutput(message.output);
        if (output === null) {
          rejectStarted(
            new Error("PolkaVM guest emitted an invalid UI platform output"),
          );
          return;
        }
        applyUiOutput(output);
        canvas.dataset.polkavmCursor = output.cursorIcon;
        canvas.dataset.polkavmIme = String(output.ime !== null);
        canvas.dataset.polkavmUiCommands = String(
          Number(canvas.dataset.polkavmUiCommands ?? 0) +
            output.commands.length,
        );
        canvas.dataset.polkavmUiLastCommands = output.commands
          .map((command) => command.type)
          .join(",");
        const command = output.commands.at(0);
        if (command?.type === "copy-text") {
          canvas.dataset.polkavmClipboardRequests = String(
            Number(canvas.dataset.polkavmClipboardRequests ?? 0) + 1,
          );
        } else if (command !== undefined) {
          canvas.dataset.polkavmNavigationRequests = String(
            Number(canvas.dataset.polkavmNavigationRequests ?? 0) + 1,
          );
        }
        postFirstUiPlatformCommand(output, window.parent, parentOrigin);
        break;
      }
      case "gpu-batch": {
        const batch = message as unknown as WorkerGpuBatch;
        if (
          (descriptor.graphicsProfile !== "webgpu-raster" &&
            descriptor.graphicsProfile !== "webgpu") ||
          webGpu === null ||
          !(batch.bytes instanceof Uint8Array) ||
          batch.bytes.byteLength === 0 ||
          batch.bytes.byteLength > 4 * 1024 * 1024
        ) {
          rejectStarted(
            new Error("PolkaVM guest emitted an invalid WebGPU batch"),
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
        polkavmMetrics.updates = values.updates;
        polkavmMetrics.updateP50Ms = values.updateP50Ms;
        polkavmMetrics.updateP95Ms = values.updateP95Ms;
        polkavmMetrics.updateMaxMs = values.updateMaxMs;
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
        stop();
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
    stop();
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
      motionAvailability:
        typeof PointerEvent !== "undefined" ||
        typeof DeviceMotionEvent !== "undefined"
          ? 1
          : 0,
      forceInterpreter,
    },
    transfers,
  );

  await startedPromise.catch((error: unknown) => {
    stop();
    throw error;
  });
}
