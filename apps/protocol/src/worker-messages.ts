// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What a tab's protocol iframe and the SharedWorker agree on over the port the worker hands each tab: the heartbeat's
// pace, and when the iframe lets go of its end.

/**
 * A closed tab's port neither throws nor tells the worker, so the iframe sends a heartbeat on this interval and the
 * worker lets go of a port it heard nothing from for this many beats. Three beats of 20 s release a dead tab's
 * connections within about a minute, and leave an iframe stuck in a long task two beats of slack.
 */
export const HEARTBEAT_INTERVAL_MS = 20_000;
export const HEARTBEAT_MISSED_BEATS = 3;

/**
 * Disposes the iframe's worker transport once its page is hidden for good, which ends its subscriptions and so frees
 * its connections at once. `pagehide` and not `beforeunload`, because a frame the host removes fires only the former.
 * A page kept in the back-forward cache may come back, so it keeps its transport.
 */
export function disposeOnPageHide(
  target: Pick<EventTarget, 'addEventListener'>,
  transport: { dispose: (reason: Error) => void },
  reason: Error,
): void {
  target.addEventListener('pagehide', event => {
    if (!(event as PageTransitionEvent).persisted) {
      transport.dispose(reason);
    }
  });
}
