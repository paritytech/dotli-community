// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ManualTimers } from '@dotli/shared/testing';
import type { Poll } from '../pagePoll.js';

type Params = {
  /** The spec's clock, which fires the ticks as the spec moves it on. */
  timers: ManualTimers;
};

/** A poll on the spec's clock, whose ticks fire as the spec moves the clock on. */
export function createManualPoll({ timers }: Params): Poll {
  return {
    start(tick, ms) {
      let waiting = timers.setTimeout(fire, ms);
      return stop;

      function fire(): void {
        waiting = timers.setTimeout(fire, ms);
        tick();
      }

      function stop(): void {
        timers.clearTimeout(waiting);
      }
    },
  };
}
