// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Console output only under DEBUG, while warn, error and event always reach the sink so production keeps a trace.
// The sink is bound from outside, since this package cannot depend on the code that binds it.

import { noop } from './noop.js';
import { serializeError } from './serializeError.js';

// Read from the build flag here rather than set at boot, so the first log of every entry point already honours it.
// Node loaders other than Vite's, such as Playwright's for test helpers, define no `import.meta.env`.
const env = import.meta.env as ImportMetaEnv | undefined;
const DEBUG = env?.VITE_APP_DEBUG === 'true';

export type LogLevel = 'info' | 'warn' | 'error';

/** One line the log hands its sink. `args` are what a warn or error was called with. */
export type LogEntry = {
  level: LogLevel;
  message: string;
  attrs: Record<string, unknown>;
  args?: unknown[];
};

export type LogSink = {
  /** Called for every warn, error and event. A throw never reaches the caller of the log, and leaves one console line. */
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
    const merged = { ...scope, ...attrs };
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
  try {
    sink?.emit(entry);
  } catch (error) {
    // The logger cannot report through itself, and a throwing sink must not break its caller, error handlers included.
    // eslint-disable-next-line no-console -- the one trace a broken sink leaves
    console.error('[dot.li log] The log sink threw:', error);
  }
}

// Strings stay as written, an empty one included. Every other argument reads as a thrown value does.
function stringifyArgs(args: unknown[]): string {
  return args.map(a => (typeof a === 'string' ? a : serializeError(a))).join(' ');
}
