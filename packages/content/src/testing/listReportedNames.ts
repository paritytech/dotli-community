// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { RecordingSentry } from '@dotli/metrics/testing';

/** Every metric, measurement and tag the page reported, by name. */
export function listReportedNames(metrics: RecordingSentry): string[] {
  return [
    ...[...metrics.counts, ...metrics.distributions, ...metrics.gauges, ...metrics.measurements].map(
      ({ name }) => name,
    ),
    ...metrics.tags.map(({ key }) => key),
  ];
}
