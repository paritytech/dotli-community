// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Product manifest types and handwritten validators.
//
// Hosts read these shapes from dotNS text records. Two records exist per
// product: a root manifest on `<id>.<tld>` (display metadata) and one
// executable manifest per modality on `app|widget|worker.<id>.<tld>`, where
// `<tld>` is the active network's dotNS TLD
// (version and kind-specific fields). Bulletin CIDs live in the subname's
// contenthash slot, not in the JSON.
//
// Validators are handwritten so the resolver package stays free of a
// schema library at runtime.

/** Formats v1 defines. A manifest may carry another; that only costs the icon. */
export type IconFormat = 'jpeg' | 'png';

export type AppVersion = readonly [number, number, number] | readonly [number, number, number, string];

export interface Icon {
  cid: string;
  format: IconFormat | (string & {});
}

export interface RootManifest {
  $v: 1;
  displayName: string;
  description: string;
  icon: Icon;
  /** `<product_id>` → what that product may do to this one. Unrecognised grants are kept, not fatal. */
  trustedProducts?: Record<string, readonly string[]>;
}

interface CommonExecutableFields {
  $v: 1;
  appVersion: AppVersion;
}

export interface AppManifest extends CommonExecutableFields {
  kind: 'app';
}

export interface WidgetDimensions {
  height: readonly number[];
  width?: number;
}

export interface WidgetManifest extends CommonExecutableFields {
  kind: 'widget';
  description?: string;
  dimensions: WidgetDimensions;
}

/** Surfaces a worker serves. An omitted key means `false`; all off is a background-only worker. */
export interface WorkerIncludes {
  chat?: boolean;
  pocket?: boolean;
  input?: boolean;
}

export interface WorkerManifest extends CommonExecutableFields {
  kind: 'worker';
  entrypoint: string;
  includes: WorkerIncludes;
}

export type ExecutableManifest = AppManifest | WidgetManifest | WorkerManifest;
export type ExecutableKind = ExecutableManifest['kind'];

export interface ValidationOk<T> {
  ok: true;
  value: T;
}
export interface ValidationErr {
  ok: false;
  errors: string[];
  /**
   * Set when `$v` is not 1, the only version this host reads. The fields are
   * not checked then: they belong to a schema this host does not know.
   */
  unsupportedVersion?: unknown;
}
export type ValidationResult<T> = ValidationOk<T> | ValidationErr;

const WORKER_SURFACES = ['chat', 'pocket', 'input'] as const;

/** The `$v` check every manifest starts with. `null` when the version is 1. */
function checkVersion(input: Record<string, unknown>, what: string): ValidationErr | null {
  const version = input['$v'];
  if (version === 1) {
    return null;
  }
  return {
    ok: false,
    unsupportedVersion: version,
    errors: [
      `${what} $v ${version === undefined ? 'undefined' : JSON.stringify(version)} is not supported (expected 1)`,
    ],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isAppVersion(value: unknown): value is AppVersion {
  if (!Array.isArray(value)) {
    return false;
  }
  if (value.length !== 3 && value.length !== 4) {
    return false;
  }
  if (!value.slice(0, 3).every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) {
    return false;
  }
  if (value.length === 4 && typeof value[3] !== 'string') {
    return false;
  }
  return true;
}

function validateWidgetFields(input: Record<string, unknown>, p: string): string[] {
  const errors: string[] = [];
  if ('description' in input && input['description'] !== undefined && typeof input['description'] !== 'string') {
    errors.push(`${p}description must be a string when present`);
  }
  if (!isPlainObject(input['dimensions'])) {
    errors.push(`${p}dimensions must be an object`);
    return errors;
  }
  const dims = input['dimensions'];
  if (
    !Array.isArray(dims['height']) ||
    dims['height'].length === 0 ||
    !dims['height'].every(h => typeof h === 'number' && Number.isInteger(h) && h > 0)
  ) {
    errors.push(`${p}dimensions.height must be a non-empty array of positive integers`);
  }
  if (
    'width' in dims &&
    dims['width'] !== undefined &&
    !(typeof dims['width'] === 'number' && Number.isInteger(dims['width']) && dims['width'] > 0)
  ) {
    errors.push(`${p}dimensions.width must be a positive integer when present`);
  }
  return errors;
}

function validateWorkerFields(input: Record<string, unknown>, p: string): string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(input['entrypoint'])) {
    errors.push(`${p}entrypoint must be a non-empty string`);
  } else if (input['entrypoint'].startsWith('/') || input['entrypoint'].split('/').includes('..')) {
    errors.push(`${p}entrypoint must be a relative path with no '..' segments`);
  }
  if (!isPlainObject(input['includes'])) {
    errors.push(`${p}includes must be an object`);
    return errors;
  }
  const inc = input['includes'];
  for (const surface of WORKER_SURFACES) {
    if (surface in inc && typeof inc[surface] !== 'boolean') {
      errors.push(`${p}includes.${surface} must be a boolean when present`);
    }
  }
  return errors;
}

function validateTrustedProducts(value: unknown): string[] {
  if (!isPlainObject(value)) {
    return ['root manifest trustedProducts must be an object when present'];
  }
  const errors: string[] = [];
  for (const [product, grants] of Object.entries(value)) {
    if (!Array.isArray(grants) || !grants.every(g => typeof g === 'string')) {
      errors.push(`root manifest trustedProducts.${product} must be an array of strings`);
    }
  }
  return errors;
}

/** Parse and validate a JSON string against the `RootManifest` schema. */
export function parseRootManifest(json: string): ValidationResult<RootManifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return {
      ok: false,
      errors: [`root manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  return validateRootManifest(raw);
}

/** Parse and validate a JSON string against the `ExecutableManifest` schema. */
export function parseExecutableManifest(json: string): ValidationResult<ExecutableManifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return {
      ok: false,
      errors: [`executable manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  return validateExecutableManifest(raw);
}

export function validateRootManifest(input: unknown): ValidationResult<RootManifest> {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['root manifest must be an object'] };
  }
  const unsupported = checkVersion(input, 'root manifest');
  if (unsupported !== null) {
    return unsupported;
  }
  if (!isNonEmptyString(input['displayName'])) {
    errors.push('root manifest displayName must be a non-empty string');
  }
  if (typeof input['description'] !== 'string') {
    errors.push('root manifest description must be a string');
  }
  if (!isPlainObject(input['icon'])) {
    errors.push('root manifest icon must be an object');
  } else {
    if (!isNonEmptyString(input['icon']['cid'])) {
      errors.push('root manifest icon.cid must be a non-empty string');
    }
    if (typeof input['icon']['format'] !== 'string') {
      errors.push('root manifest icon.format must be a string');
    }
  }
  if (input['trustedProducts'] !== undefined) {
    errors.push(...validateTrustedProducts(input['trustedProducts']));
  }
  return errors.length === 0 ? { ok: true, value: input as unknown as RootManifest } : { ok: false, errors };
}

export function validateExecutableManifest(input: unknown): ValidationResult<ExecutableManifest> {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['executable manifest must be an object'] };
  }
  const unsupported = checkVersion(input, 'executable manifest');
  if (unsupported !== null) {
    return unsupported;
  }
  if (!isAppVersion(input['appVersion'])) {
    errors.push('executable manifest appVersion must be [major, minor, patch] or [major, minor, patch, build]');
  }
  const kind = input['kind'];
  const p = 'executable manifest ';
  if (kind === 'app') {
    // App has no kind-specific fields beyond the common ones.
  } else if (kind === 'widget') {
    errors.push(...validateWidgetFields(input, p));
  } else if (kind === 'worker') {
    errors.push(...validateWorkerFields(input, p));
  } else {
    errors.push(`${p}kind must be one of app, widget, worker (got ${JSON.stringify(kind)})`);
  }
  return errors.length === 0 ? { ok: true, value: input as unknown as ExecutableManifest } : { ok: false, errors };
}

/**
 * Discriminated result so callers can tell "no manifest set" apart from
 * "manifest exists but malformed". Same shape as `decodeIpfsContenthashResult`
 *  used for legacy contenthash reads.
 *
 * Every result read from a record carries its text as `raw`, so a caller can
 * keep it and validate it again later with `toRootManifestResult` /
 * `toExecutableManifestResult`. `unsupported` is about the network (it has no
 * text records), `unsupported-version` about the manifest (a `$v` other than 1).
 */
export type ManifestResult<T> =
  | { kind: 'ok'; value: T; raw: string }
  | { kind: 'empty' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'unsupported-version'; version: unknown; raw: string }
  | { kind: 'invalid'; errors: string[]; raw: string };

/** What a manifest record's text can come to: everything but the network-level `unsupported`. */
export type ManifestRecordResult<T> = Exclude<ManifestResult<T>, { kind: 'unsupported' }>;

function toManifestResult<T>(
  raw: string | null,
  parse: (json: string) => ValidationResult<T>,
): ManifestRecordResult<T> {
  if (raw === null || raw.length === 0) {
    return { kind: 'empty' };
  }
  const parsed = parse(raw);
  if (parsed.ok) {
    return { kind: 'ok', value: parsed.value, raw };
  }
  if ('unsupportedVersion' in parsed) {
    return { kind: 'unsupported-version', version: parsed.unsupportedVersion, raw };
  }
  return { kind: 'invalid', errors: parsed.errors, raw };
}

/** Validate a root manifest record's text (`null` or empty: no record). */
export function toRootManifestResult(raw: string | null): ManifestRecordResult<RootManifest> {
  return toManifestResult(raw, parseRootManifest);
}

/**
 * Validate the text of the executable manifest read from `<kind>.<label>`.
 * A manifest whose `kind` disagrees with that subname is invalid, so one
 * tagged `kind: "worker"` cannot pose as the app.
 */
export function toExecutableManifestResult(
  raw: string | null,
  kind: ExecutableKind,
): ManifestRecordResult<ExecutableManifest> {
  const result = toManifestResult(raw, parseExecutableManifest);
  if (result.kind === 'ok' && result.value.kind !== kind) {
    return {
      kind: 'invalid',
      errors: [`executable manifest kind '${result.value.kind}' does not match its subname '${kind}'`],
      raw: result.raw,
    };
  }
  return result;
}
