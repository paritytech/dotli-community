// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

type Params = {
  now?: number;
};

/** The time from `start` to `now` in seconds to the millisecond, such as `+1.250s`. */
export function formatElapsed(start: number, { now = performance.now() }: Params = {}): string {
  return `+${((now - start) / 1000).toFixed(3)}s`;
}
