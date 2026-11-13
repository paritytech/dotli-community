// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Tells the protocol frame whether the host's network is paused, so a frame in SharedWorker mode can pass it on.

import type { ChainPoolControl } from '@dotli/chains';
import { createReporter, defineCount } from '@dotli/metrics';
import type { FrameRpc } from './createFrameRpc.js';
import { isFrameReady, type ProtocolFrame } from './frameTypes.js';
import { protocolSchema } from './schema.js';

const report = createReporter({ flow: 'protocol' });

/**
 * A pause the host could not send to its frame. Tagged `outcome` (error) and `reason` (the error's name).
 */
const protocolFramePauseMetric = defineCount<'error'>('protocol.frame_pause');

type Params = {
  /** The frame whose status says when a send can go. */
  frame: Pick<ProtocolFrame, 'status'>;
  /** The calls to the frame. */
  rpc: Pick<FrameRpc, 'request'>;
};

/** Pauses and resumes the pool that holds the frame's chains, telling each frame there is without booting one. */
export function createRemotePoolControl({ frame, rpc }: Params): ChainPoolControl {
  let paused = false;

  function isReady(): boolean {
    return isFrameReady(frame.status.get());
  }

  function send(value: boolean): void {
    rpc.request(protocolSchema.sections.frame.pause, { paused: value }).catch((error: unknown) => {
      // A frame that went down took its pause with it.
      if (!isReady()) {
        return;
      }
      report.defect(error, {
        step: 'frame_pause',
        metric: protocolFramePauseMetric,
        message: '[dot.li protocol] Frame pause send failed',
      });
    });
  }

  // A new frame starts unpaused, so it only needs telling when the host is paused. The listener lasts as long as the
  // client's frame, so it has no stop.
  frame.status.listen(status => {
    if (isFrameReady(status) && paused) {
      send(true);
    }
  });

  function latch(next: boolean): void {
    if (paused === next) {
      return;
    }
    paused = next;
    // The request would boot a frame that is not ready, and a frame that boots later hears it once it is.
    if (isReady()) {
      send(next);
    }
  }

  return {
    /**
     * Sends the pause to the frame now if it is ready, and the pause to each later frame once it is ready while it
     * lasts. A call while already paused sends nothing.
     */
    pause(): void {
      latch(true);
    },
    /**
     * Sends the resume to the frame now if it is ready, and ends the pause each later frame would hear once it is
     * ready. A call while not paused sends nothing.
     */
    resume(): void {
      latch(false);
    },
  };
}
