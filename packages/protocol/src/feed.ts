// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A subscription the host holds on the frame there is now, for as long as it listens. The frame ends one only when it
// fails, so an end is reported and the feed reopened on the same transport. A transport that closes under the feed
// ends it for good, since the frame that owned it was lost and reported, and following the next one opens it again.

import { captureException, m, spans as S } from '@dotli/metrics';
import { createAsyncTaskPool, errorName, log, named, type Timers } from '@dotli/shared';

/** The first wait before an ended feed is reopened. It doubles after each end on the same frame. */
const REOPEN_MS = 1_000;
/** The longest wait before a reopen. */
const MAX_REOPEN_MS = 30_000;
/** A feed open this long before it ended had recovered, so the waits start over. */
const STABLE_MS = 30_000;

export type FeedName = 'shared_auth' | 'telemetry';

/** How a held feed hears that it ended. */
export interface FeedEnds {
  /** The frame ended it, cleanly with null. */
  end: (error: Error | null) => void;
  /** Its transport closed under it. */
  close: () => void;
}

/**
 * Subscribes the feed on one frame's transport, and returns what stops it. Called again for each reopen on the same
 * transport.
 */
export type FeedOpen = (ends: FeedEnds) => () => void;

export interface FeedKeeper {
  /**
   * Holds the feed on the frame's transport, unless it is held there already. Asking for the transport boots a frame
   * that is down, and an answer a later ask overtook is dropped.
   */
  follow(): void;
  /** Unsubscribes the held feed, and drops a reopen that waits and an ask still out. */
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

/** `opener` is called once per transport the feed is held on, so state it keeps lives as long as that transport. */
export function createFeedKeeper<T>(
  feed: FeedName,
  frame: { transport(): Promise<T> },
  opener: (transport: T) => FeedOpen,
  timers: Timers,
): FeedKeeper {
  // A held feed is one task at a time, retried after each end with a doubling wait, and replaced by a fresh one, whose
  // waits start over, after an end that followed a stable span.
  const reopens = createAsyncTaskPool({
    poolSize: 1,
    retryCount: Number.POSITIVE_INFINITY,
    retryDelay: retry => Math.min(REOPEN_MS * 2 ** retry, MAX_REOPEN_MS),
    timers,
  });
  let held: { transport: T; run: AbortController } | null = null;
  let asks = 0;

  function stop(): void {
    asks += 1;
    held?.run.abort(new Error(`The ${feed} feed is no longer held`));
    held = null;
  }

  function hold(transport: T): void {
    if (held?.transport === transport) {
      return;
    }
    stop();
    const run = new AbortController();
    held = { transport, run };
    const open = opener(transport);
    let captured = false;
    // Fails on an end so the pool reopens the feed after a wait, and settles on an end after a stable span.
    const attempt = (): Promise<'stable' | 'done'> =>
      new Promise((resolve, reject) => {
        const openedAt = timers.now();
        const unsubscribe = open({
          end(error) {
            run.signal.removeEventListener('abort', onStop);
            const ended = error ?? named(new Error(`The frame ended the ${feed} feed`), 'ProtocolFeedEndedError');
            reportEnd(feed, ended, !captured);
            captured = true;
            if (timers.now() - openedAt >= STABLE_MS) {
              resolve('stable');
            } else {
              reject(ended);
            }
          },
          close() {
            run.signal.removeEventListener('abort', onStop);
            resolve('done');
          },
        });
        const onStop = (): void => {
          unsubscribe();
          resolve('done');
        };
        run.signal.addEventListener('abort', onStop, { once: true });
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
  }

  return {
    follow() {
      asks += 1;
      const ask = asks;
      void frame.transport().then(
        transport => {
          if (ask === asks) {
            hold(transport);
          }
        },
        (error: unknown) => {
          log.warn(`[dot.li protocol] Failed to reach the frame for the ${feed} feed:`, error);
        },
      );
    },
    stop,
  };
}
