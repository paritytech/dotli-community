// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Tells the protocol frame whether the host's network is paused, so a frame in SharedWorker mode can pass it on.

import { reportDefect, spans as S } from '@dotli/metrics';
import type { FrameRpc } from './createFrameRpc.js';
import type { ProtocolFrame } from './frameTypes.js';
import { protocolSchema } from './schema.js';

type Params = {
  /** The frame whose status says when a send can go. */
  frame: Pick<ProtocolFrame, 'status'>;
  /** The calls to the frame. */
  rpc: Pick<FrameRpc, 'request'>;
};

/** Tells each frame there is whether the host's network is paused, without booting one. */
export function createFramePauseSender({ frame, rpc }: Params) {
  let paused = false;

  function isReady(): boolean {
    return frame.status.get() === 'ready';
  }

  function send(value: boolean): void {
    rpc.request(protocolSchema.sections.frame.pause, { paused: value }).catch((error: unknown) => {
      // A frame that went down took its pause with it.
      if (!isReady()) {
        return;
      }
      reportDefect(error, {
        flow: 'protocol',
        step: 'frame_pause',
        metric: S.PROTOCOL_FRAME_PAUSE,
        message: '[dot.li protocol] Frame pause send failed',
      });
    });
  }

  // A new frame starts unpaused, so it only needs telling when the host is paused. The listener lasts as long as the
  // client's frame, so it has no stop.
  frame.status.listen(status => {
    if (status === 'ready' && paused) {
      send(true);
    }
  });

  return {
    /** Sends `paused` to the frame now if it is ready, and `true` to each later frame once it is ready. Never throws. */
    setPaused(next: boolean): void {
      paused = next;
      // The request would boot a frame that is not ready, and a frame that boots later hears it once it is.
      if (isReady()) {
        send(next);
      }
    },
  };
}
