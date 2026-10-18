// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the host hears of this frame's boot: whether it serves, and the telemetry its chain mode feeds. The host
// subscribes to both as soon as its handshake is answered, before the mode has loaded anything, and a subscription
// left waiting would never end.

import type { ProtocolSchema, TelemetryEvent } from '@dotli/protocol';
import type { CallError, MethodTypes, SubscriptionHandler } from '@dotli/transport';

import { createDeferredSubscription } from './deferred-subscription.js';
import { createFrameStatus, type FrameFailure } from './frame-status.js';

type Telemetry = SubscriptionHandler<ProtocolSchema, 'frame', 'telemetry'>;
type TelemetryStart = MethodTypes<ProtocolSchema, 'frame', 'telemetry'>['start'];

export interface FrameBoot {
  frameStatus: SubscriptionHandler<ProtocolSchema, 'frame', 'status'>;
  telemetry: Telemetry;
  /** Feeds the telemetry from the mode's light client. Only the first source, or the idle feed of `ready`, counts. */
  serveTelemetry(source: Telemetry): void;
  /** The frame serves from now on. A mode that runs no light client of its own has served none, so it reports nothing. */
  ready(): void;
  /** The frame will never serve, or has stopped for good. A telemetry subscription still waiting ends with `error`. */
  fail(error: Error): void;
  /**
   * Ends the status with another frame's end as it is, for the relay. The relay serves the telemetry before it can hear
   * an end, so none waits.
   */
  interrupt(end?: CallError<FrameFailure>): void;
}

const idleTelemetry: Telemetry = () => () => undefined;

export function createFrameBoot(): FrameBoot {
  const status = createFrameStatus();
  const telemetry = createDeferredSubscription<TelemetryStart, TelemetryEvent, never>();
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
    interrupt(end) {
      status.interrupt(end);
    },
  };
}
