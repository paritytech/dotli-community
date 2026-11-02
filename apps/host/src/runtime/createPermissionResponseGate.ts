// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A device grant from the product's own prompt rebuilds the product's frame, which must not go before the prompt's
// answer has reached the product. The gate holds a run back until it is shown that answer forwarded.

import { decodeWireMessage, MESSAGE_TYPE_RESPONSE } from '@parity/truapi';
import { PERMISSIONS_REQUEST_DEVICE_PERMISSION } from '@parity/truapi/wire-table';
import { realTimers, type Timers } from '@dotli/shared';

type Params = {
  /** The frame's lifetime. Once it aborts, nothing held back runs. */
  signal: AbortSignal;
  /** How long a run waits for an answer that may never come, as a lost one would keep the old policy in force. */
  timeoutMs: number;
  /** The timers the wait runs on. The page's own by default. */
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
};

/** Builds a gate for one frame's lifetime. Building it never throws. */
export function createPermissionResponseGate({ signal, timeoutMs, timers = realTimers }: Params) {
  let waiting: (() => void)[] = [];
  let timer: unknown;

  function release(): void {
    timers.clearTimeout(timer);
    timer = undefined;
    const ready = waiting;
    waiting = [];
    for (const run of ready) {
      run();
    }
  }

  signal.addEventListener(
    'abort',
    () => {
      timers.clearTimeout(timer);
      timer = undefined;
      waiting = [];
    },
    { once: true },
  );

  function runAfterResponse(run: () => void): void {
    if (signal.aborted) {
      return;
    }
    waiting.push(run);
    timer ??= timers.setTimeout(release, timeoutMs);
  }

  function noteForwarded(message: Uint8Array): void {
    // Frames are decoded only while something waits, so the hot path stays a length check.
    if (waiting.length === 0) {
      return;
    }
    const decoded = decodeWireMessage(message);
    if (decoded.isErr()) {
      return;
    }
    const { payload } = decoded.value;
    if (
      payload.messageType !== MESSAGE_TYPE_RESPONSE ||
      payload.traitId !== PERMISSIONS_REQUEST_DEVICE_PERMISSION.trait ||
      payload.methodId !== PERMISSIONS_REQUEST_DEVICE_PERMISSION.method
    ) {
      return;
    }
    release();
  }

  return {
    /**
     * Runs `run` once the next device permission answer has been forwarded to the product, or the wait is over, and
     * never once the frame's lifetime ended. Throws only when a run that it releases throws.
     */
    runAfterResponse,
    /**
     * Is shown each core frame once it was forwarded to the product. A device permission answer releases every held
     * run. Throws only when a run that it releases throws.
     */
    noteForwarded,
  };
}
