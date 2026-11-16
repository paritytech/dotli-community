// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { AppVersion } from '@dotli/resolver';

/** Returns `version` as `major.minor.patch`, with `-tag` when it has one. Never throws. */
export function formatAppVersion(version: AppVersion): string {
  const base = `${String(version[0])}.${String(version[1])}.${String(version[2])}`;
  if (version.length === 4) {
    return `${base}-${version[3]}`;
  }
  return base;
}
