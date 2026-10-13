// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A device grant from the product's own prompt rebuilds the product's frame, which must not go before the prompt's
// answer has reached the product. The frame's pipe shows the gate every core frame it forwarded.

import { decodeWireMessage, MESSAGE_TYPE_RESPONSE } from '@parity/truapi';
import { PERMISSIONS_REQUEST_DEVICE_PERMISSION } from '@parity/truapi/wire-table';

export interface PermissionResponseGate {
  /** Runs `run` once the next device permission answer has been forwarded to the product, or the wait is over. */
  afterResponse: (run: () => void) => void;
  /** For the pipe, after it forwarded a core frame to the product. */
  forwarded: (message: Uint8Array) => void;
}

export interface PermissionResponseGateOptions {
  /** The frame's lifetime. Once it aborts, nothing held back runs. */
  signal: AbortSignal;
  /** How long a run waits for an answer that may never come, as a lost one would keep the old policy in force. */
  timeoutMs: number;
}

export function createPermissionResponseGate({
  signal,
  timeoutMs,
}: PermissionResponseGateOptions): PermissionResponseGate {
  let waiting: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const release = (): void => {
    clearTimeout(timer);
    timer = undefined;
    const ready = waiting;
    waiting = [];
    for (const run of ready) {
      run();
    }
  };

  signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timer);
      timer = undefined;
      waiting = [];
    },
    { once: true },
  );

  return {
    afterResponse(run) {
      if (signal.aborted) {
        return;
      }
      waiting.push(run);
      timer ??= setTimeout(release, timeoutMs);
    },
    forwarded(message) {
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
    },
  };
}
