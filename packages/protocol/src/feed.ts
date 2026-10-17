// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A subscription the host holds on the frame for as long as it listens. The frame ends one only when it fails, so an
// end on a frame that stays up through the wait that follows is reported and the feed reopened on the same transport.
// The frame's loss ends it for good, since whoever follows the frame opens the feed on the next one.

import { captureException, m, spans as S } from '@dotli/metrics';
import { createAsyncTaskPool, errorName, log, named, type Timers } from '@dotli/shared';
import type { ProtocolFrame } from './frame.js';
import type { Subscription } from './transport-consumer.js';

/** The first wait before an ended feed is reopened. It doubles after each end on the same frame. */
const REOPEN_MS = 1_000;
/** The longest wait before a reopen. */
const MAX_REOPEN_MS = 30_000;
/** A feed open this long before it ended had recovered, so the waits start over. */
const STABLE_MS = 30_000;

export type FeedName = 'shared_auth' | 'telemetry';

export interface FeedKeeper {
  /**
   * Holds the subscription `open` makes, in place of the one held before, until `stop` or the frame's loss. `since` is
   * the frame's loss count when the transport `open` subscribes on was asked for, so a loss before it was handed over
   * counts.
   */
  hold(open: () => Subscription, since: number): void;
  /** Unsubscribes the held subscription, and drops a reopen that waits. */
  stop(): void;
}

/**
 * Each end is counted and logged. `capture` is set for the first end of a held feed only, so a frame that keeps ending
 * it does not flood the error tracker.
 */
function reportEnd(feed: FeedName, error: Error, capture: boolean): void {
  if (capture) {
    captureException(error, { flow: 'protocol', step: 'feed_end', tags: { feed } });
  }
  log.error(`[dot.li protocol] The frame ended the ${feed} feed, reopening it:`, error);
  m.count(S.PROTOCOL_FEED_END, { outcome: 'error', feed, reason: errorName(error) ?? 'unknown' });
}

export function createFeedKeeper(feed: FeedName, frame: Pick<ProtocolFrame, 'losses'>, timers: Timers): FeedKeeper {
  // A held feed is one task at a time, retried after each end with a doubling wait, and replaced by a fresh one, whose
  // waits start over, after an end that followed a stable span.
  const reopens = createAsyncTaskPool({
    poolSize: 1,
    retryCount: Number.POSITIVE_INFINITY,
    retryDelay: retry => Math.min(REOPEN_MS * 2 ** retry, MAX_REOPEN_MS),
    timers,
  });
  let held: AbortController | null = null;
  // Judges the end the held feed kept for its next attempt, which a stop during the wait would drop.
  let judgeKept: (() => void) | null = null;

  function stop(): void {
    judgeKept?.();
    judgeKept = null;
    held?.abort(new Error(`The ${feed} feed is no longer held`));
    held = null;
  }

  return {
    hold(open, since) {
      stop();
      const run = new AbortController();
      held = run;
      // Judged at the next attempt, once the wait gave the frame time to count a loss that ended the feed. A failed
      // handshake or a dead SharedWorker ends the feed before the frame counts its loss.
      let ended: Error | null = null;
      let captured = false;
      // The loss is reported where the frame was dropped, so only an end on a frame still up is.
      const judge = (): void => {
        if (ended !== null && frame.losses() === since) {
          reportEnd(feed, ended, !captured);
          captured = true;
        }
        ended = null;
      };
      judgeKept = judge;
      // Fails on an end so the pool reopens the feed after a wait, and settles on an end after a stable span.
      const attempt = (): Promise<'stable' | 'done'> =>
        new Promise((resolve, reject) => {
          if (frame.losses() !== since) {
            resolve('done');
            return;
          }
          judge();
          const subscription = open();
          const openedAt = timers.now();
          const onStop = (): void => {
            subscription.unsubscribe();
            resolve('done');
          };
          run.signal.addEventListener('abort', onStop, { once: true });
          subscription.onEnd(error => {
            run.signal.removeEventListener('abort', onStop);
            ended = error ?? named(new Error(`The frame ended the ${feed} feed`), 'ProtocolFeedEndedError');
            if (timers.now() - openedAt >= STABLE_MS) {
              resolve('stable');
            } else {
              reject(ended);
            }
          });
        });
      const keep = (delay: number): void => {
        reopens.call(attempt, { signal: run.signal, delay }).then(
          outcome => {
            if (outcome === 'stable') {
              keep(REOPEN_MS);
            }
          },
          () => {
            // Only `stop` rejects the endless reopens, and it wants nothing more of this feed.
          },
        );
      };
      keep(0);
    },
    stop,
  };
}
