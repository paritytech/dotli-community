// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { LightClient } from '@dotli/chains';

import type { TelemetryHandlerParams } from './createTelemetryHandler.js';

/** The database reads of `lightClient`, as the telemetry hears them. */
export function toLightClientDb(
  lightClient: Pick<LightClient, 'status' | 'subscribe'>,
): Pick<TelemetryHandlerParams, 'readDbOutcomes' | 'onDbOutcome'> {
  return {
    readDbOutcomes: () => lightClient.status().db,
    onDbOutcome: listener =>
      lightClient.subscribe(change => {
        if (change.kind === 'db') {
          listener(change.chain, change.outcome);
        }
      }),
  };
}
