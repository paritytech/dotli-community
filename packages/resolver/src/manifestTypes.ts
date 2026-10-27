// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Manifests from dotNS text records: the root on `<id>.<tld>`, one executable per kind on `<kind>.<id>.<tld>`.
// CIDs live in each name's contenthash, not the JSON.

/** Formats v1 defines. Any other value only loses the icon. */
export type IconFormat = 'jpeg' | 'png';

export type AppVersion = readonly [number, number, number] | readonly [number, number, number, string];

export type Icon = {
  cid: string;
  format: IconFormat | (string & {});
};

export type RootManifest = {
  $v: 1;
  displayName: string;
  description: string;
  icon: Icon;
  /** Keyed by product id, listing what that product may do to this one. Unknown grants are kept. */
  trustedProducts?: Record<string, readonly string[]> | undefined;
};

type CommonExecutableFields = {
  $v: 1;
  appVersion: AppVersion;
};

export type AppManifest = {
  kind: 'app';
} & CommonExecutableFields;

export type WidgetDimensions = {
  height: readonly number[];
  width?: number | undefined;
};

export type WidgetManifest = {
  kind: 'widget';
  description?: string | undefined;
  dimensions: WidgetDimensions;
} & CommonExecutableFields;

/** An omitted key means `false`. All off is a background-only worker. */
export type WorkerIncludes = {
  chat?: boolean | undefined;
  pocket?: boolean | undefined;
  input?: boolean | undefined;
};

export type WorkerManifest = {
  kind: 'worker';
  entrypoint: string;
  includes: WorkerIncludes;
} & CommonExecutableFields;

export type ExecutableManifest = AppManifest | WidgetManifest | WorkerManifest;
export type ExecutableKind = ExecutableManifest['kind'];

export type ValidationOk<T> = {
  ok: true;
  value: T;
};
export type ValidationErr = {
  ok: false;
  errors: string[];
  /** Set when `$v` is not 1, in which case the fields go unchecked. */
  unsupportedVersion?: unknown;
};
export type ValidationResult<T> = ValidationOk<T> | ValidationErr;

/**
 * `raw` lets a caller keep the text and revalidate it later. `unsupported` means the network has no text
 * records, `unsupported-version` a `$v` other than 1, with `version` as JSON, or `undefined` when absent.
 */
export type ManifestResult<T> =
  | { kind: 'ok'; value: T; raw: string }
  | { kind: 'empty' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'unsupported-version'; version: string; raw: string }
  | { kind: 'invalid'; errors: string[]; raw: string };

export type ManifestRecordResult<T> = Exclude<ManifestResult<T>, { kind: 'unsupported' }>;
