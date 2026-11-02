// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ManualTimers } from '@dotli/shared/testing';
import { createProtocolClient } from '../createProtocolClient.js';
import type { ProtocolFrameConfig, ProtocolFrameTimeouts } from '../frameTypes.js';
import { createFrameDom } from './createFrameDom.js';

export type FrameHost = ReturnType<typeof createFrameHost>;

type Params = {
  /** Overrides of the frame's lifecycle timeouts. */
  timeouts?: Partial<ProtocolFrameTimeouts> | undefined;
  /** Null leaves the client unconfigured, as before the host's boot says how to build the frame. */
  config: ProtocolFrameConfig | null;
  /** What the client waits on. */
  timers: ManualTimers;
};

/** A frame's document and window, with a client built on them and configured with `config` unless it is null. */
export function createFrameHost({ timeouts, config, timers }: Params) {
  const dom = createFrameDom({ timeouts, timers });
  const client = createProtocolClient(dom.params);
  if (config !== null) {
    client.frame.configure(config);
  }
  return { ...dom, client };
}
