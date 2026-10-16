// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Console output only under DEBUG, while warn, error and event always reach the sink so production keeps a trace.
// The sink is bound from `@dotli/metrics`, since this package cannot depend on it.

import { DEBUG } from '@dotli/config';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogSink {
  /** Called for every warn, error and event. A throw is swallowed. */
  emit: (level: LogLevel, message: string, attrs?: Record<string, unknown>, args?: unknown[]) => void;
}

let sink: LogSink | null = null;

/** A later bind replaces the earlier sink. */
export function bindLogSink(next: LogSink): void {
  sink = next;
}

function safeEmit(level: LogLevel, message: string, attrs?: Record<string, unknown>, args?: unknown[]): void {
  const s = sink;
  if (s === null) {
    return;
  }
  try {
    s.emit(level, message, attrs, args);
    // eslint-disable-next-line no-restricted-syntax -- a throwing sink would break every `log.error` caller, error handlers included.
  } catch {
    /* sinks must not break logging */
  }
}

interface BoundLogger {
  debug: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  /** Always-on lifecycle marker, sent to the sink as `info`. */
  event: (name: string, attrs?: Record<string, unknown>) => void;
  child: (scope: Record<string, unknown>) => BoundLogger;
}

// eslint-disable-next-line @typescript-eslint/no-empty-function -- debug is a no-op without DEBUG.
const noop = (): void => {};

function createLogger(scope: Record<string, unknown>): BoundLogger {
  return {
    // eslint-disable-next-line no-console -- intentional: logger module
    debug: DEBUG ? console.debug.bind(console) : noop,
    warn: (...args: unknown[]) => {
      if (DEBUG) {
        console.warn(...args);
      }
      safeEmit('warn', stringifyArgs(args), scope, args);
    },
    error: (...args: unknown[]) => {
      if (DEBUG) {
        console.error(...args);
      }
      safeEmit('error', stringifyArgs(args), scope, args);
    },
    event: (name: string, attrs?: Record<string, unknown>) => {
      const merged = attrs === undefined ? scope : { ...scope, ...attrs };
      if (DEBUG) {
        // eslint-disable-next-line no-console -- intentional info channel
        console.info(`[event] ${name}`, merged);
      }
      safeEmit('info', name, merged);
    },
    child: (extra: Record<string, unknown>) => createLogger({ ...scope, ...extra }),
  };
}

function stringifyArgs(args: unknown[]): string {
  if (args.length === 0) {
    return '';
  }
  if (args.length === 1) {
    const a = args[0];
    return typeof a === 'string' ? a : safeToString(a);
  }
  return args.map(a => (typeof a === 'string' ? a : safeToString(a))).join(' ');
}

function safeToString(v: unknown): string {
  if (v === null) {
    return 'null';
  }
  if (v === undefined) {
    return 'undefined';
  }
  if (v instanceof Error) {
    return v.message || v.name || 'Error';
  }
  if (typeof v === 'object') {
    try {
      const json = JSON.stringify(v);
      if (typeof json === 'string') {
        return json;
      }
      return Object.prototype.toString.call(v);
    } catch {
      return Object.prototype.toString.call(v);
    }
  }
  if (typeof v === 'symbol') {
    return v.toString();
  }
  if (typeof v === 'function') {
    return v.name ? `[function ${v.name}]` : '[function]';
  }
  if (typeof v === 'bigint') {
    return v.toString();
  }
  if (typeof v === 'number' || typeof v === 'boolean') {
    return v.toString();
  }
  return Object.prototype.toString.call(v);
}

export const log: BoundLogger = createLogger({});
