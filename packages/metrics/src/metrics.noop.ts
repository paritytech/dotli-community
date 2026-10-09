// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// No-op twin of `metrics.ts`, swapped in by `stripAnalytics`. Exports and return contracts must match it.

type SpanArg = { setAttribute: (key: string, value: string) => void } | undefined;

function span<T>(_name: string, fn: (s: SpanArg) => T): T;
function span<T>(_name: string, fn: (s: SpanArg) => Promise<T>): Promise<T>;
function span<T>(_name: string, fn: (s: SpanArg) => T | Promise<T>): T | Promise<T> {
  return fn(undefined);
}

function timer(_name: string): () => number {
  return () => 0;
}

export type SpanValue = string | number | boolean;

export interface SpanHandle {
  setAttributes: (attrs: Record<string, SpanValue>) => void;
  child: (name: string, opts?: OpenSpanOptions) => SpanHandle;
  end: (endTime?: number) => void;
}

export interface OpenSpanOptions {
  startTime?: number;
  attributes?: Record<string, SpanValue>;
  root?: boolean;
}

const inertSpan: SpanHandle = {
  setAttributes: () => {
    /* no-op */
  },
  child: () => inertSpan,
  end: () => {
    /* no-op */
  },
};

function open(_name: string, _opts?: OpenSpanOptions): SpanHandle {
  return inertSpan;
}

export function sentrySpanOf(_handle: SpanHandle): unknown {
  return undefined;
}

let resolutionId: string | null = null;

// Kept even here: the host reads the id back to build the protocol and sandbox URLs.
export function setResolutionId(id: string): void {
  resolutionId = id;
}

export function getResolutionId(): string | null {
  return resolutionId;
}

const noop = (): void => {
  /* no-op */
};

export const m = {
  enabled: false as const,
  bind: noop,
  span,
  open,
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
