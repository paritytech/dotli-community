// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Centralized Sentry initialization for dot.li.
//
// Kept in its own module so `@dotli/metrics/metrics` stays free of a hard
// `@sentry/browser` import. Callers that only need the `m` API (spans,
// counters, distributions) still get a Sentry-less bundle.
//
// Call once from the entry point of an app or Worker:
//
//   import { initSentry } from "@dotli/metrics/sentry";
//   initSentry("host");

import * as Sentry from "@sentry/browser";
import { bindLogSink, log, type LogLevel } from "@dotli/shared/log";
import { serializeError, fullErrorChain } from "@dotli/shared/errors";
import { m } from "./metrics";

/**
 * Logical source of a Sentry event. All surfaces report to a single Sentry
 * project ("dotli"); this value drives the `source` tag so events from host,
 * worker and sandbox stay distinguishable inside that single project.
 */
export type SentrySource = "host" | "worker" | "sandbox";

// The smoldot WASM client panics at the Rust layer and surfaces the
// crash as a `CrashError` with a `panicked at /__w/smoldot/...` message.
// These events can arrive via our own handlers or via Sentry's default
// browser integrations (e.g. `auto.browser.browserapierrors`), so we
// tag at `beforeSend` time to cover every path into the pipeline.

/** Minimal structural view of a Sentry event, decoupling the detector from `@sentry/browser` internals for testing. */
interface SmoldotEventLike {
  exception?: {
    values?: {
      type?: string;
      value?: string;
      stacktrace?: {
        frames?: { filename?: string; module?: string; abs_path?: string }[];
      };
    }[];
  };
  tags?: Record<
    string,
    string | number | boolean | bigint | symbol | null | undefined
  >;
}

// Stack frames live under `.../smoldot/dist/...` or the Bun-versioned
// `.../smoldot@2.0.40/node_modules/smoldot/...`. Both match this.
const SMOLDOT_PATH_RE = /[/\\]smoldot(?:@[\w.+-]+)?[/\\]/i;
// Rust panic messages start with `panicked at /__w/smoldot/...`. The JS
// wrapper raises "Smoldot has panicked" or "Smoldot has crashed".
const SMOLDOT_VALUE_RE =
  /panicked at [^\n]*[/\\]smoldot[/\\]|Smoldot has (?:panicked|crashed)/i;

/**
 * Return true when a Sentry event originated from smoldot: either a
 * `CrashError`, a Rust panic message, or a stack frame inside the
 * smoldot package. Exported for unit tests.
 */
export function isSmoldotEvent(event: SmoldotEventLike): boolean {
  const values = event.exception?.values ?? [];
  for (const v of values) {
    if (v.type === "CrashError") {
      return true;
    }
    if (typeof v.value === "string" && SMOLDOT_VALUE_RE.test(v.value)) {
      return true;
    }
    const frames = v.stacktrace?.frames ?? [];
    for (const f of frames) {
      const paths = [f.filename, f.module, f.abs_path];
      for (const p of paths) {
        if (typeof p === "string" && SMOLDOT_PATH_RE.test(p)) {
          return true;
        }
      }
    }
  }
  return false;
}

/** `beforeSend` hook: stamps `smoldot: "true"` on any event we detect as smoldot-origin. */
function tagSmoldotEvents<E extends SmoldotEventLike>(event: E): E {
  if (isSmoldotEvent(event)) {
    event.tags = { ...(event.tags ?? {}), smoldot: "true" };
  }
  return event;
}

/** Sentry `environment` is the deploy domain (e.g. "paseo.li"), derived from
 *  VITE_APP_URL; falls back to "development" when unset or unparseable. */
function sentryEnvironment(): string {
  const appUrl = import.meta.env.VITE_APP_URL as string | undefined;
  if (appUrl === undefined || appUrl === "") {
    return "development";
  }
  try {
    return new URL(appUrl).hostname;
  } catch {
    return "development";
  }
}

/**
 * Initialize Sentry with the dot.li-standard config for the given source
 * and bind it to `@dotli/metrics` so spans/counters flow through. Safe to
 * call unconditionally. When the DSN env var is unset, Sentry becomes a
 * no-op, but we warn loudly instead of silently disabling reporting.
 */
export function initSentry(source: SentrySource): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  const env = sentryEnvironment();
  const integrations =
    source === "worker"
      ? []
      : [Sentry.browserTracingIntegration({ idleTimeout: 120000 })];
  Sentry.init({
    dsn,
    tunnel: "/t",
    environment: env,
    release: import.meta.env.VITE_COMMIT_SHA as string | undefined,
    sendDefaultPii: false,
    beforeSend: tagSmoldotEvents,
    integrations,
    tracesSampleRate: 1.0,
  });

  // Anonymous per-browser UUID for Sentry user-level metrics. No PII.
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (ls) {
      let uuid = ls.getItem("dotli:sentry-uuid");
      if (uuid === null) {
        uuid = crypto.randomUUID();
        ls.setItem("dotli:sentry-uuid", uuid);
      }
      Sentry.setUser({ id: uuid });
    }
  } catch (err) {
    log.warn(
      "[dot.li sentry] anonymous user id setup skipped (localStorage unavailable)",
      err,
    );
  }

  m.bind(Sentry as unknown as Parameters<typeof m.bind>[0]);
  // Use the canonical schema keys documented in `metrics.ts` (`source`,
  // `env`). The metrics layer owns any Sentry-side prefixing, so pass bare
  // keys here. An already-prefixed key like `dotli_source` would become
  // `dotli.dotli_source` after the mirroring layer's prefix and drift away
  // from the documented schema.
  m.setDefaults({ source, env });

  // If the DSN is missing in any non-development build, warn loudly once so
  // an operator doesn't lose hours wondering why the dashboard is empty.
  if ((dsn === undefined || dsn === "") && env !== "development") {
    console.warn(
      `[dot.li sentry] VITE_SENTRY_DSN missing in env "${env}" — error reporting is DISABLED.`,
    );
  }

  // Wire `log.warn` / `log.error` / `log.event` into Sentry breadcrumbs so
  // handled failures leave a trace in production regardless of `DEBUG`.
  // Inline lookups keep the sink resilient to lazy Sentry initialization.
  bindLogSink({
    emit: (
      level: LogLevel,
      message: string,
      attrs?: Record<string, unknown>,
      args?: unknown[],
    ) => {
      const sentryLevel: "info" | "warning" | "error" =
        level === "error" ? "error" : level === "warn" ? "warning" : "info";
      const data: Record<string, unknown> = { ...(attrs ?? {}) };
      if (args !== undefined && args.length > 0) {
        const errArg = args.find((a) => a instanceof Error);
        if (errArg !== undefined) {
          data.error = serializeError(errArg);
        }
      }
      Sentry.addBreadcrumb({
        category: "log",
        level: sentryLevel,
        message,
        data,
      });
    },
  });
}

/**
 * Catch otherwise-silent crashes and route them to Sentry.
 *
 * Behavior:
 *   - Pass the original `Error` through directly (don't wrap), so Sentry
 *     keeps the right stack/filename/lineno.
 *   - For non-Error throws, attach the raw value via `extra.rawThrown`
 *     so the original shape isn't lost behind a synthetic `Error`.
 *   - For `ErrorEvent`, capture `event.filename`/`lineno`/`colno` even when
 *     `event.error` is null (resource-load failures, CORS-tainted scripts).
 */
export function installGlobalErrorHandlers(source: SentrySource): void {
  if (typeof self === "undefined") {
    return;
  }

  self.addEventListener(
    "unhandledrejection",
    (event: PromiseRejectionEvent) => {
      const reason: unknown = event.reason;
      log.error(`[dot.li ${source}] unhandled rejection:`, reason);
      captureException(reason, {
        kind: "unhandledrejection",
        source,
      });
    },
  );

  self.addEventListener("error", (event: ErrorEvent) => {
    log.error(`[dot.li ${source}] window error:`, event.error ?? event.message);
    const tags: Record<string, string> = {
      kind: "window_error",
      source,
    };
    const extra: Record<string, unknown> = {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      message: event.message,
    };
    if (event.error instanceof Error) {
      Sentry.captureException(event.error, { tags, extra });
    } else {
      Sentry.captureException(
        new Error(event.message || "window error (no Error object)"),
        { tags, extra: { ...extra, rawError: event.error } },
      );
    }
  });
}

/**
 * Report a caught exception to Sentry. Preserves the original `Error`
 * instance (and its stack) when present; for non-Error throws, captures a
 * synthetic Error tagged with the structured chain plus the raw value.
 */
export function captureException(
  err: unknown,
  tags?: Record<string, string>,
): void {
  if (err instanceof Error) {
    Sentry.captureException(err, tags ? { tags } : undefined);
    return;
  }
  const chain = fullErrorChain(err);
  const synthetic = new Error(serializeError(err));
  synthetic.name = "NonErrorThrow";
  Sentry.captureException(synthetic, {
    tags,
    extra: {
      rawThrown: err,
      errorChain: chain,
    },
  });
}
