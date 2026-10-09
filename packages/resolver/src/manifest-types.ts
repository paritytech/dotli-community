// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Manifests from dotNS text records: the root on `<id>.<tld>`, one executable per kind on `<kind>.<id>.<tld>`.
// CIDs live in each name's contenthash, not the JSON. Validators are handwritten to avoid a schema library.

/** Formats v1 defines. Any other value only loses the icon. */
export type IconFormat = 'jpeg' | 'png';

export type AppVersion = readonly [number, number, number] | readonly [number, number, number, string];

export interface FileInputHandler {
  id: string;
  label: string;
  extensions?: readonly string[];
  mediaTypes?: readonly string[];
  maxBytes: number;
  mountPath: string;
}

export interface FileInputRequirement {
  abiVersion: 1;
  handlers: readonly FileInputHandler[];
}

export interface Icon {
  cid: string;
  format: IconFormat | (string & {});
}

export interface RootManifest {
  $v: 1;
  displayName: string;
  description: string;
  icon: Icon;
  /** Keyed by product id, listing what that product may do to this one. Unknown grants are kept. */
  trustedProducts?: Record<string, readonly string[]>;
}

interface CommonExecutableFieldsV1 {
  $v: 1;
  appVersion: AppVersion;
}

export interface AppManifestV1 extends CommonExecutableFieldsV1 {
  kind: 'app';
}

export interface WebAppManifestV2 {
  $v: 2;
  kind: 'app';
  appVersion: AppVersion;
  runtime: {
    kind: 'web';
    entrypoint: string;
  };
}

export interface PolkaVmAppManifestV2 {
  $v: 2;
  kind: 'app';
  appVersion: AppVersion;
  runtime: {
    kind: 'polkavm';
    abiVersion: 1;
    entrypoint: string;
    fallback?: {
      kind: 'web';
      entrypoint: string;
    };
  };
  capabilities: {
    graphics: {
      abiVersion: 1;
      profile: 'framebuffer' | 'tri2d' | 'webgpu-raster' | 'webgpu';
      requiredFeatures: readonly string[];
      requiredLimits?: Readonly<Record<string, number>>;
    };
    deviceInput?: {
      abiVersion: 1;
      controls?: readonly string[];
      requiredFeatures: readonly (
        'pointer' | 'keyboard' | 'touch' | 'wheel' | 'text' | 'ime' | 'focus' | 'motion' | 'camera-ur'
      )[];
    };
    audio?: {
      abiVersion: 1;
      requiredFeatures: readonly string[];
    };
    fileInput?: FileInputRequirement;
  };
}

export type AppManifestV2 = WebAppManifestV2 | PolkaVmAppManifestV2;
export type AppManifest = AppManifestV1 | AppManifestV2;

export interface WidgetDimensions {
  height: readonly number[];
  width?: number;
}

export interface WidgetManifest extends CommonExecutableFieldsV1 {
  kind: 'widget';
  description?: string;
  dimensions: WidgetDimensions;
}

/** An omitted key means `false`. All off is a background-only worker. */
export interface WorkerIncludes {
  chat?: boolean;
  pocket?: boolean;
  input?: boolean;
}

export interface WorkerManifest extends CommonExecutableFieldsV1 {
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
   * Set when `$v` is not supported for this manifest kind. Its fields are
   * not checked then: they belong to a schema this host does not know.
   */
  unsupportedVersion?: unknown;
}
export type ValidationResult<T> = ValidationOk<T> | ValidationErr;

const WORKER_SURFACES = ['chat', 'pocket', 'input'] as const;

/** Reject unknown versions before checking fields belonging to another schema. */
function checkVersion(input: Record<string, unknown>, what: string, supportsV2 = false): ValidationErr | null {
  const version = input['$v'];
  if (version === 1 || (supportsV2 && version === 2)) {
    return null;
  }
  return {
    ok: false,
    unsupportedVersion: version,
    errors: [
      `${what} $v ${version === undefined ? 'undefined' : JSON.stringify(version)} is not supported (expected ${supportsV2 ? '1 or 2' : '1'})`,
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
  if (
    !value.slice(0, 3).every((part: unknown) => typeof part === 'number' && Number.isSafeInteger(part) && part >= 0)
  ) {
    return false;
  }
  return value.length !== 4 || isNonEmptyString(value[3]);
}

function relativePath(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').some(part => part === '' || part === '.' || part === '..')
  );
}

function relativeEntrypoint(value: unknown, suffix: string): boolean {
  return relativePath(value) && value.toLowerCase().endsWith(suffix);
}

function requiredFeatures(value: unknown, allowed: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every(feature => typeof feature === 'string' && allowed.includes(feature))
  );
}

function validFileInput(value: unknown, programPath: string): value is FileInputRequirement {
  if (
    !isPlainObject(value) ||
    value['abiVersion'] !== 1 ||
    !Array.isArray(value['handlers']) ||
    value['handlers'].length === 0 ||
    value['handlers'].length > 16 ||
    Object.keys(value).some(key => !['abiVersion', 'handlers'].includes(key))
  ) {
    return false;
  }
  const ids = new Set<string>();
  const mountPaths = new Set<string>();
  const encoder = new TextEncoder();
  for (const rawHandler of value['handlers']) {
    const handler = isPlainObject(rawHandler) ? rawHandler : null;
    const extensions = handler?.['extensions'] ?? [];
    const mediaTypes = handler?.['mediaTypes'] ?? [];
    if (
      handler === null ||
      Object.keys(handler).some(
        key => !['id', 'label', 'extensions', 'mediaTypes', 'maxBytes', 'mountPath'].includes(key),
      ) ||
      typeof handler['id'] !== 'string' ||
      !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(handler['id']) ||
      ids.has(handler['id']) ||
      typeof handler['label'] !== 'string' ||
      handler['label'].trim() === '' ||
      encoder.encode(handler['label']).byteLength > 80 ||
      !Array.isArray(extensions) ||
      !Array.isArray(mediaTypes) ||
      (extensions.length === 0 && mediaTypes.length === 0) ||
      new Set(extensions).size !== extensions.length ||
      extensions.some(extension => typeof extension !== 'string' || !/^\.[a-z0-9]{1,16}$/.test(extension)) ||
      new Set(mediaTypes).size !== mediaTypes.length ||
      mediaTypes.some(
        mediaType =>
          typeof mediaType !== 'string' ||
          mediaType.length > 127 ||
          !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType),
      ) ||
      !Number.isSafeInteger(handler['maxBytes']) ||
      Number(handler['maxBytes']) < 1 ||
      Number(handler['maxBytes']) > 128 * 1024 * 1024 ||
      !relativePath(handler['mountPath']) ||
      encoder.encode(handler['mountPath']).byteLength > 1_024 ||
      handler['mountPath'] === programPath ||
      mountPaths.has(handler['mountPath'])
    ) {
      return false;
    }
    ids.add(handler['id']);
    mountPaths.add(handler['mountPath']);
  }
  return true;
}

function validateAppV2(input: Record<string, unknown>, p: string): string[] {
  const errors: string[] = [];
  const runtime = isPlainObject(input['runtime']) ? input['runtime'] : null;
  if (runtime === null) {
    return [`${p}runtime must be an object`];
  }
  if (runtime['kind'] === 'web') {
    if (!relativeEntrypoint(runtime['entrypoint'], '.html')) {
      errors.push(`${p}web runtime entrypoint must be a relative HTML path`);
    }
    if (input['capabilities'] !== undefined) {
      errors.push(`${p}web runtime must not declare PolkaVM capabilities`);
    }
    return errors;
  }
  if (runtime['kind'] !== 'polkavm') {
    return [`${p}runtime.kind must be web or polkavm`];
  }
  // The App manifest version ($v) and the runtime ABI version are independent:
  // v2 manifests select the PolkaVM application runtime ABI v1, which is the
  // only version the runtime contract defines and every published App declares.
  if (runtime['abiVersion'] !== 1) {
    errors.push(`${p}PolkaVM runtime abiVersion must be 1`);
  }
  if (!relativeEntrypoint(runtime['entrypoint'], '.polkavm')) {
    errors.push(`${p}PolkaVM entrypoint must be a relative .polkavm path`);
  }
  if (runtime['fallback'] !== undefined) {
    const fallback = isPlainObject(runtime['fallback']) ? runtime['fallback'] : null;
    if (fallback?.['kind'] !== 'web' || !relativeEntrypoint(fallback['entrypoint'], '.html')) {
      errors.push(`${p}PolkaVM runtime fallback must be a relative web entrypoint`);
    }
  }
  const capabilities = isPlainObject(input['capabilities']) ? input['capabilities'] : null;
  const graphics = capabilities !== null && isPlainObject(capabilities['graphics']) ? capabilities['graphics'] : null;
  if (graphics === null) {
    errors.push(`${p}PolkaVM capabilities.graphics must be an object`);
  } else {
    if (
      graphics['abiVersion'] !== 1 ||
      typeof graphics['profile'] !== 'string' ||
      !['framebuffer', 'tri2d', 'webgpu-raster', 'webgpu'].includes(graphics['profile'])
    ) {
      errors.push(`${p}graphics must select a supported ABI version 1 profile`);
    }
    if (!requiredFeatures(graphics['requiredFeatures'], [])) {
      errors.push(`${p}graphics.requiredFeatures contains unsupported values`);
    }
  }
  if (capabilities?.['deviceInput'] !== undefined) {
    const encoder = new TextEncoder();
    const inputCapability = isPlainObject(capabilities['deviceInput']) ? capabilities['deviceInput'] : null;
    if (inputCapability === null) {
      errors.push(`${p}deviceInput capability is unsupported`);
    } else if (
      Object.keys(inputCapability).some(key => !['abiVersion', 'requiredFeatures', 'controls'].includes(key)) ||
      (inputCapability['controls'] !== undefined &&
        (!Array.isArray(inputCapability['controls']) ||
          inputCapability['controls'].length > 32 ||
          inputCapability['controls'].some(
            control =>
              typeof control !== 'string' ||
              control.length === 0 ||
              /^\p{White_Space}|\p{White_Space}$/u.test(control) ||
              encoder.encode(control).byteLength > 160,
          ))) ||
      inputCapability['abiVersion'] !== 1 ||
      !requiredFeatures(inputCapability['requiredFeatures'], [
        'pointer',
        'keyboard',
        'touch',
        'wheel',
        'text',
        'ime',
        'focus',
        'motion',
        'camera-ur',
      ])
    ) {
      errors.push(`${p}deviceInput capability is unsupported`);
    }
  }
  if (capabilities?.['audio'] !== undefined) {
    const audio = isPlainObject(capabilities['audio']) ? capabilities['audio'] : null;
    if (audio === null) {
      errors.push(`${p}audio capability is unsupported`);
    } else if (audio['abiVersion'] !== 1 || !requiredFeatures(audio['requiredFeatures'], [])) {
      errors.push(`${p}audio capability is unsupported`);
    }
  }
  if (
    capabilities?.['fileInput'] !== undefined &&
    (typeof runtime['entrypoint'] !== 'string' || !validFileInput(capabilities['fileInput'], runtime['entrypoint']))
  ) {
    errors.push(`${p}fileInput capability is unsupported`);
  }
  return errors;
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
  const unsupported = checkVersion(input, 'executable manifest', input['kind'] === 'app');
  if (unsupported !== null) {
    return unsupported;
  }
  if (!isAppVersion(input['appVersion'])) {
    errors.push('executable manifest appVersion must be [major, minor, patch] or [major, minor, patch, build]');
  }
  const kind = input['kind'];
  const p = 'executable manifest ';
  if (kind === 'app' && input['$v'] === 2) {
    errors.push(...validateAppV2(input, p));
  } else {
    if (kind === 'app') {
      // App v1 has no kind-specific fields.
    } else if (kind === 'widget') {
      errors.push(...validateWidgetFields(input, p));
    } else if (kind === 'worker') {
      errors.push(...validateWorkerFields(input, p));
    } else {
      errors.push(`${p}kind must be one of app, widget, worker (got ${JSON.stringify(kind)})`);
    }
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
 * text records), `unsupported-version` about a version this host cannot read.
 */
export type ManifestResult<T> =
  | { kind: 'ok'; value: T; raw: string }
  | { kind: 'empty' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'unsupported-version'; version: unknown; raw: string }
  | { kind: 'invalid'; errors: string[]; raw: string };

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

export function toRootManifestResult(raw: string | null): ManifestRecordResult<RootManifest> {
  return toManifestResult(raw, parseRootManifest);
}

/** A `kind` that disagrees with the subname is invalid, so a worker cannot pose as the app. */
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
