// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Handwritten to avoid a schema library.

import { isRecord, isStringArray } from '@dotli/shared';
import { checkVersion, isNonEmptyString, parseManifestJson } from './manifestFieldChecks.js';
import type { RootManifest, ValidationResult } from './manifestTypes.js';

/** Checks every field of a root manifest, collecting each error. A `$v` other than 1 skips the field checks. */
export function validateRootManifest(input: unknown): ValidationResult<RootManifest> {
  const errors: string[] = [];
  if (!isRecord(input)) {
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
  if (!isRecord(input['icon'])) {
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
  // Every field `RootManifest` names was checked above, and extra fields pass through to the caller.
  return errors.length === 0 ? { ok: true, value: input as unknown as RootManifest } : { ok: false, errors };
}

/** Parses a root manifest record's text, then validates it. */
export function parseRootManifest(json: string): ValidationResult<RootManifest> {
  const parsed = parseManifestJson(json, 'root manifest');
  return parsed.ok ? validateRootManifest(parsed.value) : parsed;
}

function validateTrustedProducts(value: unknown): string[] {
  if (!isRecord(value)) {
    return ['root manifest trustedProducts must be an object when present'];
  }
  const errors: string[] = [];
  for (const [product, grants] of Object.entries(value)) {
    if (!isStringArray(grants)) {
      errors.push(`root manifest trustedProducts.${product} must be an array of strings`);
    }
  }
  return errors;
}
