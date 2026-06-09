// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Prod no-op shim for `@dotli/metrics/metrics`, aliased in
// `apps/*/vite.config.ts`. Return contracts must match `metrics.ts`:
// `span(name, fn)` returns `fn(undefined)` (sync and async), and `timer`
// returns a stop fn.

type SpanArg =
  | { setAttribute: (key: string, value: string) => void }
  | undefined;

function span<T>(_name: string, fn: (s: SpanArg) => T): T;
function span<T>(_name: string, fn: (s: SpanArg) => Promise<T>): Promise<T>;
function span<T>(
  _name: string,
  fn: (s: SpanArg) => T | Promise<T>,
): T | Promise<T> {
  return fn(undefined);
}

function timer(_name: string): () => number {
  return () => 0;
}

const noop = (): void => {
  /* no-op */
};

export const m = {
  enabled: false as const,
  bind: noop,
  span,
  measure: noop,
  count: noop,
  distribution: noop,
  gauge: noop,
  tag: noop,
  setDefaults: noop,
  clearDefaults: noop,
  breadcrumb: noop,
  timer,
} as const;
