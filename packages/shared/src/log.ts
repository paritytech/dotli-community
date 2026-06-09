// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li debug logger.
//
// Thin wrapper around console that respects the DEBUG flag for verbose
// channels but ALWAYS routes warn/error to a registered side-channel
// (typically Sentry breadcrumbs):
// - `log.debug` is a no-op when DEBUG is false (verbose tracing only).
// - `log.warn` and `log.error` ALWAYS reach the registered side-channel so
//   handled failures leave a trace in production, regardless of DEBUG.
// - `log.event` records a lifecycle marker (always-on side-channel).
//
// Side-channel registration is inverted to avoid a dependency from
// `shared` on `metrics`. `@dotli/metrics` calls `bindLogSink` on init.
//
// `log.child(scope)` creates a logger whose output prepends a tag and
// merges scope attributes into the side-channel payload. Wire it to
// `metrics.setDefaults` so logs and metrics agree on which mode/provider
// was active.

import { DEBUG } from "@dotli/config/config";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogSink {
  /**
   * Called for every `log.warn`, `log.error`, and `log.event` call. The sink
   * decides whether to forward to Sentry, console, etc. Sinks must not
   * throw. Failures here are silent.
   */
  emit: (
    level: LogLevel,
    message: string,
    attrs?: Record<string, unknown>,
    args?: unknown[],
  ) => void;
}

let sink: LogSink | null = null;

/**
 * Wire a side-channel sink (e.g. Sentry breadcrumbs). Called once during
 * app bootstrap from `@dotli/metrics`. Multiple binds replace the prior
 * sink (no fan-out).
 */
export function bindLogSink(next: LogSink): void {
  sink = next;
}

function safeEmit(
  level: LogLevel,
  message: string,
  attrs?: Record<string, unknown>,
  args?: unknown[],
): void {
  const s = sink;
  if (s === null) {
    return;
  }
  try {
    s.emit(level, message, attrs, args);
    // eslint-disable-next-line no-restricted-syntax -- the log sink is the deepest observability primitive in the stack; letting it re-throw would break every caller of `log.error` (including error handlers themselves). Intentionally swallow.
  } catch {
    /* sinks must not break logging */
  }
}

interface BoundLogger {
  debug: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  /** Always-on lifecycle marker; sink receives `level: "info"`. */
  event: (name: string, attrs?: Record<string, unknown>) => void;
  /** Returns a child logger with a scope tag merged into every emit. */
  child: (scope: Record<string, unknown>) => BoundLogger;
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = (): void => {};

function createLogger(scope: Record<string, unknown>): BoundLogger {
  return {
    // eslint-disable-next-line no-console -- intentional: logger module
    debug: DEBUG ? console.debug.bind(console) : noop,
    warn: (...args: unknown[]) => {
      if (DEBUG) {
        console.warn(...args);
      }
      safeEmit("warn", stringifyArgs(args), scope, args);
    },
    error: (...args: unknown[]) => {
      if (DEBUG) {
        console.error(...args);
      }
      safeEmit("error", stringifyArgs(args), scope, args);
    },
    event: (name: string, attrs?: Record<string, unknown>) => {
      const merged = attrs === undefined ? scope : { ...scope, ...attrs };
      if (DEBUG) {
        // eslint-disable-next-line no-console -- intentional info channel
        console.info(`[event] ${name}`, merged);
      }
      safeEmit("info", name, merged);
    },
    child: (extra: Record<string, unknown>) =>
      createLogger({ ...scope, ...extra }),
  };
}

function stringifyArgs(args: unknown[]): string {
  if (args.length === 0) {
    return "";
  }
  if (args.length === 1) {
    const a = args[0];
    return typeof a === "string" ? a : safeToString(a);
  }
  return args
    .map((a) => (typeof a === "string" ? a : safeToString(a)))
    .join(" ");
}

function safeToString(v: unknown): string {
  if (v === null) {
    return "null";
  }
  if (v === undefined) {
    return "undefined";
  }
  if (v instanceof Error) {
    return v.message || v.name || "Error";
  }
  if (typeof v === "object") {
    try {
      const json = JSON.stringify(v);
      if (typeof json === "string") {
        return json;
      }
      return Object.prototype.toString.call(v);
    } catch {
      return Object.prototype.toString.call(v);
    }
  }
  if (typeof v === "symbol") {
    return v.toString();
  }
  if (typeof v === "function") {
    return v.name ? `[function ${v.name}]` : "[function]";
  }
  if (typeof v === "bigint") {
    return v.toString();
  }
  if (typeof v === "number" || typeof v === "boolean") {
    return v.toString();
  }
  return Object.prototype.toString.call(v);
}

export const log: BoundLogger = createLogger({});
