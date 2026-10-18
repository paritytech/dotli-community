// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the light client reports for the host's network panel and telemetry tags, as one subscription. A subscriber
// that comes late hears where things stand first, so nothing reported before it subscribed is lost.

import type { ChainDetail, ChainSyncEvent, SmoldotDbChain, SmoldotDbOutcome } from '@dotli/chains';
import type { ProtocolSchema } from '@dotli/protocol';
import type { SubscriptionHandler } from '@dotli/transport';

import { chainDetailTelemetry, chainSyncTelemetry, netBytesTelemetry, smoldotDbTelemetry } from './telemetry-events.js';

export interface TelemetryDeps {
  /** Replays each chain's latest state to a new listener, then hears each change. */
  onChainSync: (listener: (event: ChainSyncEvent) => void) => () => void;
  /** Replays each chain's facts to a new listener, then hears each new one. */
  onChainDetail: (listener: (detail: ChainDetail) => void) => () => void;
  /** Each chain's first read of its stored database, so far. */
  dbOutcomes: () => ReadonlyMap<SmoldotDbChain, SmoldotDbOutcome>;
  /** Hears each read after the call. */
  onDbOutcome: (listener: (chain: SmoldotDbChain, outcome: SmoldotDbOutcome) => void) => () => void;
  /** Hears the byte total at once, then on an interval. */
  netBytes: (listener: (total: number) => void) => () => void;
  /**
   * Whether the chains were synced when this subscriber came, so it paid no sync cost. A tab that joins a synced
   * SharedWorker hears the reads made before it as hits, since what it loads comes from chains already warm.
   */
  joinedSynced: () => boolean;
}

export function createTelemetryHandler(deps: TelemetryDeps): SubscriptionHandler<ProtocolSchema, 'frame', 'telemetry'> {
  return (_payload, _context, sink) => {
    const stops: (() => void)[] = [];
    const stopAll = (): void => {
      for (const stop of stops.splice(0).reverse()) {
        stop();
      }
    };
    try {
      const synced = deps.joinedSynced();
      let replaying = true;
      stops.push(
        deps.onChainSync(event => {
          sink.receive(chainSyncTelemetry(event));
        }),
      );
      stops.push(
        deps.onChainDetail(detail => {
          const reported =
            replaying && synced && detail.dbCache !== undefined ? { ...detail, dbCache: 'hit' as const } : detail;
          sink.receive(chainDetailTelemetry(reported));
        }),
      );
      replaying = false;
      for (const [chain, outcome] of deps.dbOutcomes()) {
        sink.receive(smoldotDbTelemetry(chain, synced ? 'hit' : outcome));
      }
      stops.push(
        deps.onDbOutcome((chain, outcome) => {
          sink.receive(smoldotDbTelemetry(chain, outcome));
        }),
      );
      stops.push(
        deps.netBytes(total => {
          sink.receive(netBytesTelemetry(total));
        }),
      );
    } catch (error) {
      // The transport ends the subscription with this error and never gets a stop, so the feeds started are stopped
      // here.
      stopAll();
      throw error;
    }
    return stopAll;
  };
}
