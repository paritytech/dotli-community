// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Handwritten to avoid a schema library.

import { isRecord } from '@dotli/shared';
import { checkVersion, isNonEmptyString, parseManifestJson } from './manifestFieldChecks.js';
import type { AppVersion, ExecutableManifest, ValidationResult, WorkerIncludes } from './manifestTypes.js';

const WORKER_SURFACES: readonly (keyof WorkerIncludes)[] = ['chat', 'pocket', 'input'];

/** Checks every field of an executable manifest, collecting each error. A `$v` other than 1 skips the field checks. */
export function validateExecutableManifest(input: unknown): ValidationResult<ExecutableManifest> {
  const errors: string[] = [];
  if (!isRecord(input)) {
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
  switch (kind) {
    case 'app':
      // No kind-specific fields.
      break;
    case 'widget':
      errors.push(...validateWidgetFields(input));
      break;
    case 'worker':
      errors.push(...validateWorkerFields(input));
      break;
    default:
      errors.push(`executable manifest kind must be one of app, widget, worker (got ${JSON.stringify(kind)})`);
  }
  // Every field the manifest's kind names was checked above, and extra fields pass through to the caller.
  return errors.length === 0 ? { ok: true, value: input as unknown as ExecutableManifest } : { ok: false, errors };
}

/** Parses an executable manifest record's text, then validates it. */
export function parseExecutableManifest(json: string): ValidationResult<ExecutableManifest> {
  const parsed = parseManifestJson(json, 'executable manifest');
  return parsed.ok ? validateExecutableManifest(parsed.value) : parsed;
}

/** Narrows a value to an app version: three non-negative safe integers, optionally followed by a string build tag. */
function isAppVersion(value: unknown): value is AppVersion {
  if (!Array.isArray(value)) {
    return false;
  }
  if (value.length !== 3 && value.length !== 4) {
    return false;
  }
  if (!value.slice(0, 3).every(part => typeof part === 'number' && Number.isSafeInteger(part) && part >= 0)) {
    return false;
  }
  if (value.length === 4 && typeof value[3] !== 'string') {
    return false;
  }
  return true;
}

function validateWidgetFields(input: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (input['description'] !== undefined && typeof input['description'] !== 'string') {
    errors.push('executable manifest description must be a string when present');
  }
  if (!isRecord(input['dimensions'])) {
    errors.push('executable manifest dimensions must be an object');
    return errors;
  }
  const dimensions = input['dimensions'];
  if (
    !Array.isArray(dimensions['height']) ||
    dimensions['height'].length === 0 ||
    !dimensions['height'].every(h => typeof h === 'number' && Number.isInteger(h) && h > 0)
  ) {
    errors.push('executable manifest dimensions.height must be a non-empty array of positive integers');
  }
  if (
    dimensions['width'] !== undefined &&
    !(typeof dimensions['width'] === 'number' && Number.isInteger(dimensions['width']) && dimensions['width'] > 0)
  ) {
    errors.push('executable manifest dimensions.width must be a positive integer when present');
  }
  return errors;
}

/** Whether a path leaves its directory once a URL resolver reads a backslash as a slash and `%2e` as `.`. */
function isEscapingPath(path: string): boolean {
  // A URL resolver drops tabs and newlines anywhere, and controls and spaces at either end.
  // eslint-disable-next-line no-control-regex -- the range is the C0 controls and the space a URL resolver trims.
  const resolved = path.replace(/[\t\n\r]/g, '').replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');
  // A scheme makes the path a URL of its own, and a query or a fragment ends the last segment.
  const pathname = resolved.split(/[?#]/, 1)[0] ?? '';
  return (
    /^[a-z][a-z\d+.-]*:/i.test(resolved) ||
    /^[/\\]/.test(pathname) ||
    pathname.split(/[/\\]/).some(segment => segment.replace(/%2e/gi, '.') === '..')
  );
}

function validateWorkerFields(input: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(input['entrypoint'])) {
    errors.push('executable manifest entrypoint must be a non-empty string');
  } else if (isEscapingPath(input['entrypoint'])) {
    errors.push(`executable manifest entrypoint must be a relative path with no '..' segments`);
  }
  if (!isRecord(input['includes'])) {
    errors.push('executable manifest includes must be an object');
    return errors;
  }
  const includes = input['includes'];
  for (const surface of WORKER_SURFACES) {
    if (surface in includes && typeof includes[surface] !== 'boolean') {
      errors.push(`executable manifest includes.${surface} must be a boolean when present`);
    }
  }
  return errors;
}
