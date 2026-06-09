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

interface CommonExecutableFields {
  $v: 1;
  appVersion: AppVersion;
}

export interface AppManifest extends CommonExecutableFields {
  kind: "app";
}

export interface WidgetDimensions {
  height: readonly number[];
  width?: number;
}

export interface WidgetManifest extends CommonExecutableFields {
  kind: "widget";
  description?: string;
  dimensions: WidgetDimensions;
}

export interface WorkerIncludes {
  chat: boolean;
  pocket: boolean;
}

export interface WorkerManifest extends CommonExecutableFields {
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
      .every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)
  ) {
    return false;
  }
  if (value.length === 4 && typeof value[3] !== "string") {
    return false;
  }
  return true;
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
  if (input.$v !== 1) {
    errors.push(
      `executable manifest $v must be 1 (got ${JSON.stringify(input.$v)})`,
    );
  }
  if (!isAppVersion(input.appVersion)) {
    errors.push(
      "executable manifest appVersion must be [major, minor, patch] or [major, minor, patch, build]",
    );
  }
  const kind = input.kind;
  const p = "executable manifest ";
  if (kind === "app") {
    // App has no kind-specific fields beyond the common ones.
  } else if (kind === "widget") {
    errors.push(...validateWidgetFields(input, p));
  } else if (kind === "worker") {
    errors.push(...validateWorkerFields(input, p));
  } else {
    errors.push(
      `${p}kind must be one of app, widget, worker (got ${JSON.stringify(kind)})`,
    );
  }
  return errors.length === 0
    ? { ok: true, value: input as unknown as ExecutableManifest }
    : { ok: false, errors };
}
