// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the host hears of this frame's boot: whether it serves, and the telemetry its chain mode feeds. The host
// subscribes to both as soon as its handshake is answered, before the mode has loaded anything, and a subscription
// left waiting would never end.

import type { SubscriptionHandler } from '@dotli/protocol';

import { createDeferredSubscription } from './deferred-subscription.js';
import { createFrameStatus } from './frame-status.js';

export interface FrameBoot {
  frameStatus: SubscriptionHandler<'frameStatus'>;
  telemetry: SubscriptionHandler<'telemetry'>;
  /** Feeds the telemetry from the mode's light client. Only the first source, or the idle feed of `ready`, counts. */
  serveTelemetry(source: SubscriptionHandler<'telemetry'>): void;
  /** The frame serves from now on. A mode that runs no light client of its own has served none, so it reports nothing. */
  ready(): void;
  /** The frame will never serve, or has stopped for good. A telemetry subscription still waiting ends with `error`. */
  fail(error: Error): void;
}

const idleTelemetry: SubscriptionHandler<'telemetry'> = () => () => undefined;

export function createFrameBoot(): FrameBoot {
  const status = createFrameStatus();
  const telemetry = createDeferredSubscription<'telemetry'>();
  return {
    frameStatus: status.handler,
    telemetry: telemetry.handler,
    serveTelemetry(source) {
      telemetry.serve(source);
    },
    ready() {
      telemetry.serve(idleTelemetry);
      status.ready();
    },
    fail(error) {
      status.fail(error);
      telemetry.fail(error);
    },
  };
}
