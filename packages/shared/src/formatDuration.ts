// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

type Params = {
  now?: number;
};

/** The time from `start` to `now` in whole milliseconds, such as `120ms`. */
export function formatDuration(start: number, { now = performance.now() }: Params = {}): string {
  return `${(now - start).toFixed(0)}ms`;
}
