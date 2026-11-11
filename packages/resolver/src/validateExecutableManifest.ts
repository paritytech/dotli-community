// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Handwritten to avoid a schema library.

import { isRecord } from '@dotli/shared';
import { checkVersion, isAppVersion, isNonEmptyString, parseManifestJson } from './manifestFieldChecks.js';
import type { ExecutableManifest, ValidationResult } from './manifestTypes.js';

const WORKER_SURFACES = ['chat', 'pocket', 'input'] as const;

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
  const prefix = 'executable manifest ';
  if (kind === 'app') {
    // No kind-specific fields.
  } else if (kind === 'widget') {
    errors.push(...validateWidgetFields(input, prefix));
  } else if (kind === 'worker') {
    errors.push(...validateWorkerFields(input, prefix));
  } else {
    errors.push(`${prefix}kind must be one of app, widget, worker (got ${JSON.stringify(kind)})`);
  }
  // Every field the manifest's kind names was checked above, and extra fields pass through to the caller.
  return errors.length === 0 ? { ok: true, value: input as unknown as ExecutableManifest } : { ok: false, errors };
}

/** Parses an executable manifest record's text, then validates it. */
export function parseExecutableManifest(json: string): ValidationResult<ExecutableManifest> {
  const parsed = parseManifestJson(json, 'executable manifest');
  return parsed.ok ? validateExecutableManifest(parsed.value) : parsed;
}

function validateWidgetFields(input: Record<string, unknown>, prefix: string): string[] {
  const errors: string[] = [];
  if ('description' in input && input['description'] !== undefined && typeof input['description'] !== 'string') {
    errors.push(`${prefix}description must be a string when present`);
  }
  if (!isRecord(input['dimensions'])) {
    errors.push(`${prefix}dimensions must be an object`);
    return errors;
  }
  const dimensions = input['dimensions'];
  if (
    !Array.isArray(dimensions['height']) ||
    dimensions['height'].length === 0 ||
    !dimensions['height'].every(h => typeof h === 'number' && Number.isInteger(h) && h > 0)
  ) {
    errors.push(`${prefix}dimensions.height must be a non-empty array of positive integers`);
  }
  if (
    'width' in dimensions &&
    dimensions['width'] !== undefined &&
    !(typeof dimensions['width'] === 'number' && Number.isInteger(dimensions['width']) && dimensions['width'] > 0)
  ) {
    errors.push(`${prefix}dimensions.width must be a positive integer when present`);
  }
  return errors;
}

/** Whether a path leaves its directory once a URL resolver reads a backslash as a slash and `%2e` as `.`. */
function isEscapingPath(path: string): boolean {
  return /^[/\\]/.test(path) || path.split(/[/\\]/).some(segment => segment.replace(/%2e/gi, '.') === '..');
}

function validateWorkerFields(input: Record<string, unknown>, prefix: string): string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(input['entrypoint'])) {
    errors.push(`${prefix}entrypoint must be a non-empty string`);
  } else if (isEscapingPath(input['entrypoint'])) {
    errors.push(`${prefix}entrypoint must be a relative path with no '..' segments`);
  }
  if (!isRecord(input['includes'])) {
    errors.push(`${prefix}includes must be an object`);
    return errors;
  }
  const includes = input['includes'];
  for (const surface of WORKER_SURFACES) {
    if (surface in includes && typeof includes[surface] !== 'boolean') {
      errors.push(`${prefix}includes.${surface} must be a boolean when present`);
    }
  }
  return errors;
}
