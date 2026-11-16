// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export type ManifestRejection = 'unsupported-version' | 'invalid' | 'missing-root';

/** A product whose manifests rule out opening it. Deterministic: a reload reads the same records. */
export class ManifestRejectedError extends Error {
  readonly reason: ManifestRejection;
  readonly record: 'root' | 'app';

  constructor(reason: ManifestRejection, record: 'root' | 'app', detail: string) {
    super(`${record} manifest ${reason}: ${detail}`);
    this.name = 'ManifestRejectedError';
    this.reason = reason;
    this.record = record;
  }
}
