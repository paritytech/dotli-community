// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A subscription the host holds on the frame for as long as it listens. The frame ends one only when it fails, so an
// end on a frame that stays up is reported and the feed reopened on the same transport. The frame's loss ends it for
// good, since whoever follows the frame opens the feed on the next one.

import { captureException, m, spans as S } from '@dotli/metrics';
import { createAsyncTaskPool, errorName, log, named, type Timers } from '@dotli/shared';
import type { ProtocolFrame } from './frame.js';
import type { Subscription } from './transport-consumer.js';

/** The first wait before an ended feed is reopened. It doubles after each end on the same frame. */
const REOPEN_MS = 1_000;
/** The longest wait before a reopen. */
const MAX_REOPEN_MS = 30_000;

export type FeedName = 'shared_auth' | 'telemetry';

export interface FeedKeeper {
  /** Holds the subscription `open` makes, in place of the one held before, until `stop` or the frame's loss. */
  hold(open: () => Subscription): void;
  /** Unsubscribes the held subscription, and drops a reopen that waits. */
  stop(): void;
}

function reportEnd(feed: FeedName, error: Error): void {
  captureException(error, { flow: 'protocol', step: 'feed_end', tags: { feed } });
  log.error(`[dot.li protocol] The frame ended the ${feed} feed, reopening it:`, error);
  m.count(S.PROTOCOL_FEED_END, { outcome: 'error', feed, reason: errorName(error) ?? 'unknown' });
}

export function createFeedKeeper(feed: FeedName, frame: Pick<ProtocolFrame, 'losses'>, timers: Timers): FeedKeeper {
  // A held feed is one task, which fails on each end so the pool reopens it, and settles on the frame's loss.
  const reopens = createAsyncTaskPool({
    poolSize: 1,
    retryCount: Number.POSITIVE_INFINITY,
    retryDelay: retry => Math.min(REOPEN_MS * 2 ** retry, MAX_REOPEN_MS),
    timers,
  });
  let held: AbortController | null = null;

  function stop(): void {
    held?.abort(new Error(`The ${feed} feed is no longer held`));
    held = null;
  }

  return {
    hold(open) {
      stop();
      const run = new AbortController();
      held = run;
      const since = frame.losses();
      const lost = (): boolean => frame.losses() !== since;
      reopens
        .call(
          () =>
            new Promise<void>((resolve, reject) => {
              if (lost()) {
                resolve();
                return;
              }
              const subscription = open();
              const onStop = (): void => {
                subscription.unsubscribe();
                resolve();
              };
              run.signal.addEventListener('abort', onStop, { once: true });
              subscription.onEnd(error => {
                run.signal.removeEventListener('abort', onStop);
                // The loss is reported where the frame was dropped.
                if (lost()) {
                  resolve();
                  return;
                }
                const reason = error ?? named(new Error(`The frame ended the ${feed} feed`), 'ProtocolFeedEndedError');
                reportEnd(feed, reason);
                reject(reason);
              });
            }),
          { signal: run.signal },
        )
        .then(
          () => undefined,
          () => {
            // Only `stop` rejects the endless reopens, and it wants nothing more of this feed.
          },
        );
    },
    stop,
  };
}
