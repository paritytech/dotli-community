// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Console output only under DEBUG, while warn, error and event always reach the sink so production keeps a trace.
// The sink is bound from `@dotli/metrics`, since this package cannot depend on it.

import { noop } from './noop.js';

// Read from the build flag here rather than set at boot, so the first log of every entry point already honours it.
// Node loaders other than Vite's, such as Playwright's for test helpers, define no `import.meta.env`.
const env = import.meta.env as ImportMetaEnv | undefined;
const DEBUG = env?.VITE_APP_DEBUG === 'true';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** One line the log hands its sink. `args` are what a warn or error was called with. */
export type LogEntry = {
  level: LogLevel;
  message: string;
  attrs?: Record<string, unknown>;
  args?: unknown[];
};

export type LogSink = {
  /** Called for every warn, error and event. A throw is swallowed. */
  emit: (entry: LogEntry) => void;
};

type BoundLogger = ReturnType<typeof createLogger>;

let sink: LogSink | null = null;

// Bound rather than wrapped, so the console shows the caller's line.
// eslint-disable-next-line no-console -- the logger is what writes to the console
const debug: (...args: unknown[]) => void = DEBUG ? console.debug.bind(console) : noop;

export const log = createLogger({});

/** A later bind replaces the earlier sink. Returns a function that puts back the sink bound before. */
export function bindLogSink(next: LogSink): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

function createLogger(scope: Record<string, unknown>) {
  return {
    debug,
    warn,
    error,
    /** Always-on lifecycle marker, sent to the sink as `info`. */
    event,
    createChild,
  };

  function warn(...args: unknown[]): void {
    if (DEBUG) {
      // eslint-disable-next-line no-console -- the logger is what writes to the console
      console.warn(...args);
    }
    emitToSink({ level: 'warn', message: stringifyArgs(args), attrs: scope, args });
  }

  function error(...args: unknown[]): void {
    if (DEBUG) {
      // eslint-disable-next-line no-console -- the logger is what writes to the console
      console.error(...args);
    }
    emitToSink({ level: 'error', message: stringifyArgs(args), attrs: scope, args });
  }

  function event(name: string, attrs?: Record<string, unknown>): void {
    const merged = attrs === undefined ? scope : { ...scope, ...attrs };
    if (DEBUG) {
      // eslint-disable-next-line no-console -- intentional info channel
      console.info(`[event] ${name}`, merged);
    }
    emitToSink({ level: 'info', message: name, attrs: merged });
  }

  function createChild(extra: Record<string, unknown>): BoundLogger {
    return createLogger({ ...scope, ...extra });
  }
}

function emitToSink(entry: LogEntry): void {
  const bound = sink;
  if (bound === null) {
    return;
  }
  try {
    bound.emit(entry);
    // eslint-disable-next-line no-restricted-syntax -- a throwing sink would break every `log.error` caller, error handlers included.
  } catch {
    /* sinks must not break logging */
  }
}

function stringifyArgs(args: unknown[]): string {
  if (args.length === 0) {
    return '';
  }
  if (args.length === 1) {
    const first = args[0];
    return typeof first === 'string' ? first : stringifyValue(first);
  }
  return args.map(a => (typeof a === 'string' ? a : stringifyValue(a))).join(' ');
}

function stringifyValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undefined';
  }
  if (value instanceof Error) {
    return value.message || value.name || 'Error';
  }
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      if (typeof json === 'string') {
        return json;
      }
      return Object.prototype.toString.call(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  if (typeof value === 'symbol') {
    return value.toString();
  }
  if (typeof value === 'function') {
    return value.name ? `[function ${value.name}]` : '[function]';
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value.toString();
  }
  return Object.prototype.toString.call(value);
}
