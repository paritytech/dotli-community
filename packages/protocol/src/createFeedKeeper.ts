// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A subscription the host holds on the frame there is now, and on each frame that boots or starts listening after it,
// for as long as it listens. The frame ends one only when it fails, so an end is reported and the feed reopened on the
// same transport. A transport that closes under the feed ends it for good, since the frame that owned it was lost and
// reported, and following the next one opens it again.

import { createReporter, defineCount } from '@dotli/metrics';
import { createAsyncTaskPool, getErrorName, log, setErrorName, type Timers } from '@dotli/shared';
import type { ProtocolFrame, ProtocolStatus } from './frameTypes.js';
import type { FrameSubscriber } from './subscribe.js';

const report = createReporter({ flow: 'protocol' });

/**
 * A feed the protocol frame ended while it stayed up, so the host reopens it after a backoff. Tagged `outcome` (error),
 * `feed` (shared_auth or telemetry) and `reason` (the error's name, `ProtocolFeedEndedError` for an end without one).
 */
const protocolFeedEndMetric = defineCount<'error'>('protocol.feed_end');

export type FeedName = 'shared_auth' | 'telemetry';

/** How a held feed hears that the frame ended it, or that its transport closed under it. */
export type FeedEnds = Required<Pick<FrameSubscriber<unknown>, 'end' | 'close'>>;

/**
 * Subscribes the feed on one frame's transport, and returns its `unsubscribe`. Called again for each reopen on the same
 * transport.
 */
export type FeedOpen = (ends: FeedEnds) => () => void;

/** What a feed needs of the frame. */
export type FeedFrame<T> = {
  /** The transport of the frame there is now. Rejects when no frame can be reached. */
  getTransport(): Promise<T>;
} & Pick<ProtocolFrame, 'status'>;

type Params<T> = {
  feed: FeedName;
  frame: FeedFrame<T>;
  /**
   * Called once per transport the feed is held on, so state it keeps lives as long as that transport. Returns how the
   * feed is opened on it.
   */
  opener: (transport: T) => FeedOpen;
  /**
   * Whether `follow` asks for a transport even when the frame is down, which boots one. A feed that does not boot only
   * hears a frame there is.
   */
  boots: boolean;
  /** What a reopen waits on. */
  timers: Timers;
};

type ReportEndParams = {
  feed: FeedName;
  error: Error;
  /** Set for the first end of a held feed only, so a frame that keeps ending it does not flood the error tracker. */
  capture: boolean;
};

/** The first wait before an ended feed is reopened. It doubles after each end on the same frame. */
const REOPEN_MS = 1_000;
/** The longest wait before a reopen. */
const MAX_REOPEN_MS = 30_000;
/** A feed open this long before it ended had recovered, so the waits start over. */
const STABLE_MS = 30_000;

/** Holds `feed` on the frame there is now once asked to `follow`. Subscribes to the frame's status at once. */
export function createFeedKeeper<T>({ feed, frame, opener, boots, timers }: Params<T>) {
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
  let wanted = false;

  function drop(): void {
    held?.run.abort(new Error(`The ${feed} feed is no longer held`));
    held = null;
  }

  function hold(transport: T): void {
    if (held?.transport === transport) {
      return;
    }
    drop();
    const run = new AbortController();
    held = { transport, run };
    const open = opener(transport);
    let captured = false;

    // Fails on an end so the pool reopens the feed after a wait, and settles on an end after a stable span.
    function attempt(): Promise<'stable' | 'done'> {
      return new Promise((resolve, reject) => {
        const openedAt = timers.now();
        const unsubscribe = open({
          end(error) {
            run.signal.removeEventListener('abort', handleStop);
            const ended =
              error ?? setErrorName(new Error(`The frame ended the ${feed} feed`), 'ProtocolFeedEndedError');
            reportEnd({ feed, error: ended, capture: !captured });
            captured = true;
            if (timers.now() - openedAt >= STABLE_MS) {
              resolve('stable');
            } else {
              reject(ended);
            }
          },
          close() {
            run.signal.removeEventListener('abort', handleStop);
            resolve('done');
          },
        });
        function handleStop(): void {
          unsubscribe();
          resolve('done');
        }
        run.signal.addEventListener('abort', handleStop, { once: true });
      });
    }

    function keep(delay: number): void {
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
    }

    keep(0);
  }

  function ask(): void {
    asks += 1;
    const asked = asks;
    void frame.getTransport().then(
      transport => {
        if (asked === asks) {
          hold(transport);
        }
      },
      (error: unknown) => {
        // The frame reports its own loss and boot failure, and a config change that drops a frame is no failure.
        report.log.event('protocol feed ask failed', { feed, reason: getErrorName(error) ?? 'unknown' });
      },
    );
  }

  // A new frame relays nothing to a feed held on the one it replaces. A frame that starts listening may have replaced a
  // held one, and a feed that already holds the transport it gets is left as it is.
  frame.status.listen(status => {
    if (wanted && (status === 'booting' || status === 'listening')) {
      ask();
    }
  });

  return {
    /**
     * Holds the feed from now on, on the frame there is now and on each frame that boots or starts listening after it,
     * until `stop`. An answer to an ask for a frame's transport that a later ask overtook is dropped. Returns nothing
     * and never throws.
     */
    follow(): void {
      wanted = true;
      if (boots || hasFrame(frame.status.get())) {
        ask();
      }
    },
    /** Unsubscribes the held feed, and drops a reopen that waits and an ask still out. Never throws. */
    stop(): void {
      wanted = false;
      asks += 1;
      drop();
    },
  };
}

/** A frame that is booting or up has a transport to hear. */
function hasFrame(status: ProtocolStatus): boolean {
  switch (status) {
    case 'booting':
    case 'listening':
    case 'ready':
      return true;
    case 'idle':
    case 'failed':
      return false;
  }
}

/** Counts and logs each end, and captures it when `capture` says so. */
function reportEnd({ feed, error, capture }: ReportEndParams): void {
  const message = `[dot.li protocol] The frame ended the ${feed} feed, reopening it:`;
  const attributes = { feed };
  if (capture) {
    report.defect(error, {
      step: 'feed_end',
      tags: { feed },
      attributes,
      metric: protocolFeedEndMetric,
      message,
    });
    return;
  }
  log.error(message, error);
  protocolFeedEndMetric.count({ outcome: 'error', ...attributes, reason: getErrorName(error) ?? 'unknown' });
}
