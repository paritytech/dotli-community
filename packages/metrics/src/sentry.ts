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

/**
 * Storage key holding the anonymous analytics id.
 *
 * Exported so a full reset can carry it across `localStorage.clear()` and so
 * the cross-subdomain reconciler can address it. A reset that dropped this key
 * turned one returning visitor into a brand new one on every wipe.
 */
export const ANALYTICS_USER_KEY = "dotli:sentry-uuid";

function localStorageOrNull(): Storage | null {
  return (globalThis as { localStorage?: Storage }).localStorage ?? null;
}

/** The analytics id this origin has stored, or `null` if it has none yet. */
export function getAnalyticsUser(): string | null {
  try {
    return localStorageOrNull()?.getItem(ANALYTICS_USER_KEY) ?? null;
  } catch {
    // localStorage may be unavailable in Safari private mode. An absent id is
    // the safe answer, the caller then leaves the Sentry scope untouched.
    return null;
  }
}

/**
 * Adopt `id` as the analytics identity for this origin.
 *
 * `initSentry` mints a per-origin id synchronously, because it must run before
 * anything that can throw. The cross-subdomain id can only be read
 * asynchronously, so it arrives later and replaces the local one here. Writing
 * the mirror as well means the next boot is already correct without waiting.
 */
export function adoptAnalyticsUser(id: string): void {
  try {
    localStorageOrNull()?.setItem(ANALYTICS_USER_KEY, id);
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable, and the Sentry scope below is what actually matters.
  } catch {
    /* mirror is best-effort */
  }
  Sentry.setUser({ id });
}

// The smoldot WASM client panics at the Rust layer and surfaces the
// crash as a `CrashError` with a `panicked at /__w/smoldot/...` message.
// These events can arrive via our own handlers or via Sentry's default
// browser integrations, so we tag at `beforeSend` time to cover every path
// into the pipeline.

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

const BROWSER_API_ERRORS_INTEGRATION = "BrowserApiErrors";

/**
 * Exclude Sentry's callback wrapper while retaining its other defaults.
 *
 * `@polkadot-api/utils` represents `noop` as `Function.prototype`, and the
 * WebSocket provider registers it as an event listener while disconnecting.
 * BrowserApiErrors stores `__sentry_wrapped__` on that callback. Because every
 * function inherits from Function.prototype, all later callbacks then look
 * already wrapped and Sentry replaces them with the same no-op. In production
 * this made every event listener registered after a chain disconnect inert,
 * including modal buttons.
 *
 * GlobalHandlers plus our explicit global error handlers still capture
 * uncaught errors and unhandled rejections without mutating callbacks.
 */
export function excludeBrowserApiErrorsIntegration<T extends { name: string }>(
  defaultIntegrations: T[],
): T[] {
  return defaultIntegrations.filter(
    (integration) => integration.name !== BROWSER_API_ERRORS_INTEGRATION,
  );
}

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
  const extraIntegrations =
    source === "worker"
      ? []
      : [
          // Overriding the default instance: kill all automatic breadcrumb
          // sources. Sentry.addBreadcrumb() still works.
          Sentry.breadcrumbsIntegration({
            dom: false, // clicks/keypresses (selectors, sometimes text)
            history: false, // URL navigation history
            fetch: false, // request URLs
            xhr: false,
            console: false, // console output can carry user data
          }),
        ];
  Sentry.init({
    dsn,
    tunnel: "/t",
    environment: env,
    release: import.meta.env.VITE_COMMIT_SHA as string | undefined,
    beforeSend: tagSmoldotEvents,
    integrations: (defaultIntegrations) => [
      ...excludeBrowserApiErrorsIntegration(defaultIntegrations),
      ...extraIntegrations,
    ],
    // Never attach user info
    sendDefaultPii: false,
    // Needed so your manual Sentry.startSpan() calls are sent.
    // WITHOUT browserTracingIntegration there is NO automatic
    // pageload, navigation, INP/interaction, fetch, or XHR spans
    tracesSampleRate: 1.0,
    // Don't inject sentry-trace/baggage headers into outgoing requests
    // (avoids leaking trace IDs to third-party endpoints).
    tracePropagationTargets: [],
  });

  // Anonymous per-browser UUID for Sentry user-level metrics. No PII.
  //
  // Read synchronously, because this runs before anything that can throw and
  // an async read would lose early events. It is per-origin, so the same person
  // on two app subdomains starts with two ids. `reconcileAnalyticsUser` in
  // `@dotli/ui` collapses them once the shared store is reachable.
  try {
    const ls = localStorageOrNull();
    if (ls) {
      let uuid = ls.getItem(ANALYTICS_USER_KEY);
      if (uuid === null) {
        uuid = crypto.randomUUID();
        ls.setItem(ANALYTICS_USER_KEY, uuid);
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
