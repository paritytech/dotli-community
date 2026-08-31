// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Product manifest types and handwritten validators.
//
// Hosts read these shapes from dotNS text records. Two records exist per
// product: a root manifest on `<id>.dot` (display metadata) and one
// executable manifest per modality on `app|widget|worker.<id>.dot`
// (version and kind-specific fields). Bulletin CIDs live in the subname's
// contenthash slot, not in the JSON.
//
// Validators are handwritten so the resolver package stays free of a
// schema library at runtime.

export type IconFormat = "jpeg" | "png";

export type AppVersion =
  | readonly [number, number, number]
  | readonly [number, number, number, string];

export interface Icon {
  cid: string;
  format: IconFormat;
}

export interface RootManifest {
  $v: 1;
  displayName: string;
  description: string;
  icon: Icon;
}

interface CommonExecutableFieldsV1 {
  $v: 1;
  appVersion: AppVersion;
}

export interface AppManifestV1 extends CommonExecutableFieldsV1 {
  kind: "app";
}

export interface WebAppManifestV2 {
  $v: 2;
  kind: "app";
  appVersion: AppVersion;
  runtime: {
    kind: "web";
    entrypoint: string;
  };
}

export interface PolkaVmAppManifestV2 {
  $v: 2;
  kind: "app";
  appVersion: AppVersion;
  runtime: {
    kind: "polkavm";
    abiVersion: 1;
    entrypoint: string;
  };
  capabilities: {
    graphics: {
      abiVersion: 1;
      profile: "framebuffer" | "tri2d" | "webgpu-raster";
      requiredFeatures: readonly string[];
      requiredLimits?: Readonly<Record<string, number>>;
    };
    deviceInput?: {
      abiVersion: 1;
      requiredFeatures: readonly (
        | "pointer"
        | "keyboard"
        | "touch"
        | "wheel"
        | "text"
        | "ime"
        | "focus"
        | "motion"
      )[];
    };
    audio?: {
      abiVersion: 1;
      requiredFeatures: readonly string[];
    };
  };
}

export type AppManifestV2 = WebAppManifestV2 | PolkaVmAppManifestV2;
export type AppManifest = AppManifestV1 | AppManifestV2;

export interface WidgetDimensions {
  height: readonly number[];
  width?: number;
}

export interface WidgetManifest extends CommonExecutableFieldsV1 {
  kind: "widget";
  description?: string;
  dimensions: WidgetDimensions;
}

export interface WorkerIncludes {
  chat: boolean;
  pocket: boolean;
}

export interface WorkerManifest extends CommonExecutableFieldsV1 {
  kind: "worker";
  entrypoint: string;
  includes: WorkerIncludes;
}

export type ExecutableManifest = AppManifest | WidgetManifest | WorkerManifest;
export type ExecutableKind = ExecutableManifest["kind"];

export interface ValidationOk<T> {
  ok: true;
  value: T;
}
export interface ValidationErr {
  ok: false;
  errors: string[];
}
export type ValidationResult<T> = ValidationOk<T> | ValidationErr;

const ICON_FORMATS: readonly IconFormat[] = ["jpeg", "png"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAppVersion(value: unknown): value is AppVersion {
  if (!Array.isArray(value)) {
    return false;
  }
  if (value.length !== 3 && value.length !== 4) {
    return false;
  }
  if (
    !value
      .slice(0, 3)
      .every((part) => Number.isSafeInteger(part) && (part as number) >= 0)
  ) {
    return false;
  }
  return value.length !== 4 || isNonEmptyString(value[3]);
}

function relativeEntrypoint(value: unknown, suffix: string): boolean {
  return (
    isNonEmptyString(value) &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..") &&
    value.toLowerCase().endsWith(suffix)
  );
}

function requiredFeatures(value: unknown, allowed: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every(
      (feature) => typeof feature === "string" && allowed.includes(feature),
    )
  );
}

function validateAppV2(input: Record<string, unknown>, p: string): string[] {
  const errors: string[] = [];
  const runtime = isPlainObject(input.runtime) ? input.runtime : null;
  if (runtime === null) {
    return [`${p}runtime must be an object`];
  }
  if (runtime.kind === "web") {
    if (!relativeEntrypoint(runtime.entrypoint, ".html")) {
      errors.push(`${p}web runtime entrypoint must be a relative HTML path`);
    }
    if (input.capabilities !== undefined) {
      errors.push(`${p}web runtime must not declare PolkaVM capabilities`);
    }
    return errors;
  }
  if (runtime.kind !== "polkavm") {
    return [`${p}runtime.kind must be web or polkavm`];
  }
  if (runtime.abiVersion !== 1) {
    errors.push(`${p}PolkaVM runtime abiVersion must be 1`);
  }
  if (!relativeEntrypoint(runtime.entrypoint, ".polkavm")) {
    errors.push(`${p}PolkaVM entrypoint must be a relative .polkavm path`);
  }
  const capabilities = isPlainObject(input.capabilities)
    ? input.capabilities
    : null;
  const graphics =
    capabilities !== null && isPlainObject(capabilities.graphics)
      ? capabilities.graphics
      : null;
  if (graphics === null) {
    errors.push(`${p}PolkaVM capabilities.graphics must be an object`);
  } else {
    if (
      graphics.abiVersion !== 1 ||
      !["framebuffer", "tri2d", "webgpu-raster"].includes(
        graphics.profile as string,
      )
    ) {
      errors.push(`${p}graphics must select a supported ABI version 1 profile`);
    }
    if (!requiredFeatures(graphics.requiredFeatures, [])) {
      errors.push(`${p}graphics.requiredFeatures contains unsupported values`);
    }
  }
  if (capabilities?.deviceInput !== undefined) {
    const inputCapability = isPlainObject(capabilities.deviceInput)
      ? capabilities.deviceInput
      : null;
    if (inputCapability === null) {
      errors.push(`${p}deviceInput capability is unsupported`);
    } else if (
      inputCapability.abiVersion !== 1 ||
      !requiredFeatures(inputCapability.requiredFeatures, [
        "pointer",
        "keyboard",
        "touch",
        "wheel",
        "text",
        "ime",
        "focus",
        "motion",
      ])
    ) {
      errors.push(`${p}deviceInput capability is unsupported`);
    }
  }
  if (capabilities?.audio !== undefined) {
    const audio = isPlainObject(capabilities.audio) ? capabilities.audio : null;
    if (audio === null) {
      errors.push(`${p}audio capability is unsupported`);
    } else if (
      audio.abiVersion !== 1 ||
      !requiredFeatures(audio.requiredFeatures, [])
    ) {
      errors.push(`${p}audio capability is unsupported`);
    }
  }
  return errors;
}

function validateWidgetFields(
  input: Record<string, unknown>,
  p: string,
): string[] {
  const errors: string[] = [];
  if (
    "description" in input &&
    input.description !== undefined &&
    typeof input.description !== "string"
  ) {
    errors.push(`${p}description must be a string when present`);
  }
  if (!isPlainObject(input.dimensions)) {
    errors.push(`${p}dimensions must be an object`);
    return errors;
  }
  const dims = input.dimensions;
  if (
    !Array.isArray(dims.height) ||
    dims.height.length === 0 ||
    !dims.height.every(
      (h) => typeof h === "number" && Number.isInteger(h) && h > 0,
    )
  ) {
    errors.push(
      `${p}dimensions.height must be a non-empty array of positive integers`,
    );
  }
  if (
    "width" in dims &&
    dims.width !== undefined &&
    !(
      typeof dims.width === "number" &&
      Number.isInteger(dims.width) &&
      dims.width > 0
    )
  ) {
    errors.push(`${p}dimensions.width must be a positive integer when present`);
  }
  return errors;
}

function validateWorkerFields(
  input: Record<string, unknown>,
  p: string,
): string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(input.entrypoint)) {
    errors.push(`${p}entrypoint must be a non-empty string`);
  } else if (
    input.entrypoint.startsWith("/") ||
    input.entrypoint.split("/").includes("..")
  ) {
    errors.push(`${p}entrypoint must be a relative path with no '..' segments`);
  }
  if (!isPlainObject(input.includes)) {
    errors.push(`${p}includes must be an object`);
    return errors;
  }
  const inc = input.includes;
  if (typeof inc.chat !== "boolean") {
    errors.push(`${p}includes.chat must be a boolean`);
  }
  if (typeof inc.pocket !== "boolean") {
    errors.push(`${p}includes.pocket must be a boolean`);
  }
  if (inc.chat === false && inc.pocket === false) {
    errors.push(`${p}includes must have at least one of chat / pocket = true`);
  }
  return errors;
}

/** Parse and validate a JSON string against the `RootManifest` schema. */
export function parseRootManifest(
  json: string,
): ValidationResult<RootManifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return {
      ok: false,
      errors: [
        `root manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
  return validateRootManifest(raw);
}

/** Parse and validate a JSON string against the `ExecutableManifest` schema. */
export function parseExecutableManifest(
  json: string,
): ValidationResult<ExecutableManifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return {
      ok: false,
      errors: [
        `executable manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
  return validateExecutableManifest(raw);
}

export function validateRootManifest(
  input: unknown,
): ValidationResult<RootManifest> {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ["root manifest must be an object"] };
  }
  if (input.$v !== 1) {
    errors.push(`root manifest $v must be 1 (got ${JSON.stringify(input.$v)})`);
  }
  if (!isNonEmptyString(input.displayName)) {
    errors.push("root manifest displayName must be a non-empty string");
  }
  if (typeof input.description !== "string") {
    errors.push("root manifest description must be a string");
  }
  if (!isPlainObject(input.icon)) {
    errors.push("root manifest icon must be an object");
  } else {
    if (!isNonEmptyString(input.icon.cid)) {
      errors.push("root manifest icon.cid must be a non-empty string");
    }
    if (!ICON_FORMATS.includes(input.icon.format as IconFormat)) {
      errors.push(
        `root manifest icon.format must be one of ${ICON_FORMATS.join(", ")} (got ${JSON.stringify(input.icon.format)})`,
      );
    }
  }
  return errors.length === 0
    ? { ok: true, value: input as unknown as RootManifest }
    : { ok: false, errors };
}

export function validateExecutableManifest(
  input: unknown,
): ValidationResult<ExecutableManifest> {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ["executable manifest must be an object"] };
  }
  if (!isAppVersion(input.appVersion)) {
    errors.push(
      "executable manifest appVersion must be [major, minor, patch] or [major, minor, patch, build]",
    );
  }
  const kind = input.kind;
  const p = "executable manifest ";
  if (kind === "app" && input.$v === 2) {
    errors.push(...validateAppV2(input, p));
  } else {
    if (input.$v !== 1) {
      errors.push(
        `executable manifest $v must be 1 (got ${JSON.stringify(input.$v)})`,
      );
    }
    if (kind === "app") {
      // App v1 has no kind-specific fields.
    } else if (kind === "widget") {
      errors.push(...validateWidgetFields(input, p));
    } else if (kind === "worker") {
      errors.push(...validateWorkerFields(input, p));
    } else {
      errors.push(
        `${p}kind must be one of app, widget, worker (got ${JSON.stringify(kind)})`,
      );
    }
  }
  return errors.length === 0
    ? { ok: true, value: input as unknown as ExecutableManifest }
    : { ok: false, errors };
}
