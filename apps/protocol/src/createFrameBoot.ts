// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the host hears of this frame's boot: whether it serves, and the telemetry its chain mode feeds. Either can be
// subscribed before the mode has loaded anything, and a refusal then would never be retried on that frame. So the
// frame accepts a subscription before what feeds it has loaded, and ends every one it holds when it fails.

import { createFrameStatus, type FrameStatusEnd, type TelemetryEvent } from '@dotli/protocol';

import { createDeferredSubscription } from './createDeferredSubscription.js';
import type { TelemetryHandler } from './createTelemetryHandler.js';

/** What the host hears of this frame's boot. */
export type FrameBoot = ReturnType<typeof createFrameBoot>;

/** A frame's boot, booting until it is told ready or failed. Never throws. */
export function createFrameBoot() {
  const status = createFrameStatus();
  const telemetry = createDeferredSubscription<undefined, TelemetryEvent, undefined>();

  return {
    /** Serves the frame's status, which ends once the frame fails or is interrupted. Never throws. */
    handleStatus: status.handler,
    /**
     * Serves the telemetry, each subscription waiting until a source is served. Throws what the source throws on start
     * once it is served.
     */
    handleTelemetry: telemetry.accept,
    /**
     * Feeds the telemetry from the mode's light client. Only the first source, or the idle feed of `markReady`, counts.
     * Never throws.
     */
    serveTelemetry,
    /**
     * The frame serves from now on. A mode that runs no light client of its own has served none, so it reports nothing.
     * Never throws.
     */
    markReady,
    /**
     * The frame will never serve, or has stopped for good. A telemetry subscription still waiting ends with `error`.
     * Never throws.
     */
    fail,
    /**
     * Ends the status with another frame's end as it is. A telemetry subscription still waiting keeps waiting. Only the
     * first end is heard. Never throws.
     */
    interrupt,
  };

  function serveTelemetry(source: TelemetryHandler): void {
    telemetry.serve(source);
  }

  function markReady(): void {
    telemetry.serve(startIdleTelemetry);
    status.markReady();
  }

  function fail(error: Error): void {
    status.fail(error);
    telemetry.fail(error);
  }

  function interrupt(end: FrameStatusEnd): void {
    status.interrupt(end);
  }
}

/** The feed of a frame that runs no light client: it starts nothing and says nothing until stopped. */
function startIdleTelemetry(): () => void {
  return () => undefined;
}
