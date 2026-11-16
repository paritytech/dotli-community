// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the light client reports for the host's network panel and telemetry tags, as one subscription. A subscriber
// that comes late hears where things stand first, so nothing reported before it subscribed is lost.

import type { ChainDetail, ChainSyncEvent, SmoldotDbChain, SmoldotDbOutcome } from '@dotli/chains';
import type { ProtocolContext, ProtocolHandler, protocolSchema } from '@dotli/protocol';

export type TelemetryHandlerParams = {
  /** Replays each chain's latest state to a new listener, then hears each change. */
  onChainSync: (listener: (event: ChainSyncEvent) => void) => () => void;
  /** Replays each chain's facts to a new listener, then hears each new one. */
  onChainDetail: (listener: (detail: ChainDetail) => void) => () => void;
  /** Each chain's first read of its stored database, so far. */
  readDbOutcomes: () => ReadonlyMap<SmoldotDbChain, SmoldotDbOutcome>;
  /** Hears each read after the call. */
  onDbOutcome: (listener: (chain: SmoldotDbChain, outcome: SmoldotDbOutcome) => void) => () => void;
  /** Hears the byte total at once, then on an interval. */
  onNetBytes: (listener: (total: number) => void) => () => void;
  /**
   * Whether the chains were synced when this subscriber came, so it paid no sync cost. A tab that joins a synced
   * SharedWorker hears the reads made before it as hits, since what it loads comes from chains already warm.
   */
  hasJoinedSynced: () => boolean;
};

/** A `frame.telemetry` handler, which serves one subscription and returns its stop. */
export type TelemetryHandler = ProtocolHandler<typeof protocolSchema.sections.frame.telemetry>;

/** The `frame.telemetry` handler over the feeds. A feed that throws on start ends the subscription. Never throws. */
export function createTelemetryHandler({
  onChainSync,
  onChainDetail,
  readDbOutcomes,
  onDbOutcome,
  onNetBytes,
  hasJoinedSynced,
}: TelemetryHandlerParams): TelemetryHandler {
  return startTelemetry;

  function startTelemetry(
    _payload: undefined,
    _context: ProtocolContext,
    sink: Parameters<TelemetryHandler>[2],
  ): () => void {
    const stops: (() => void)[] = [];
    try {
      const synced = hasJoinedSynced();
      let replaying = true;
      stops.push(
        onChainSync(event => {
          sink.send({ tag: 'chainSync', value: event });
        }),
      );
      stops.push(
        onChainDetail(detail => {
          const reported =
            replaying && synced && detail.dbCache !== undefined ? { ...detail, dbCache: 'hit' as const } : detail;
          sink.send({ tag: 'chainDetail', value: reported });
        }),
      );
      replaying = false;
      for (const [chain, outcome] of readDbOutcomes()) {
        sink.send({ tag: 'smoldotDb', value: { chain, outcome: synced ? 'hit' : outcome } });
      }
      stops.push(
        onDbOutcome((chain, outcome) => {
          sink.send({ tag: 'smoldotDb', value: { chain, outcome } });
        }),
      );
      stops.push(
        onNetBytes(total => {
          sink.send({ tag: 'netBytes', value: total });
        }),
      );
    } catch (error) {
      // The transport ends the subscription with this error and never gets a stop, so the feeds started are stopped
      // here.
      stopAll();
      throw error;
    }
    return stopAll;

    function stopAll(): void {
      for (const stop of stops.splice(0).reverse()) {
        stop();
      }
    }
  }
}
