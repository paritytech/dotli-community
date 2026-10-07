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

import * as Sentry from '@sentry/browser';
import { bindLogSink, log, type LogLevel, serializeError, fullErrorChain } from '@dotli/shared';

import { m, sentrySpanOf, type SpanHandle } from './metrics.js';

/**
 * Logical source of a Sentry event. All surfaces report to a single Sentry
 * project ("dotli"); this value drives the `source` tag so events from the
 * host shell, the protocol iframe, the worker and the sandbox stay
 * distinguishable inside that single project.
 */
export type SentrySource = 'host' | 'protocol' | 'worker' | 'sandbox';

/**
 * The user flow an event belongs to.
 *
 * Every capture names one, so a Sentry reader can tell what the visitor was
 * doing from the tags alone, and a dashboard can count failures per flow
 * without parsing messages.
 */
export type Flow =
  'boot' | 'resolve' | 'content' | 'protocol' | 'wallet' | 'storage' | 'notifications' | 'pwa' | 'ui' | 'chat';

export interface CaptureContext {
  flow: Flow;
  /**
   * The step inside the flow that failed, in snake_case (`manifest_read`).
   * Part of the issue fingerprint, so keep it stable and low-cardinality:
   * never a label, CID or message.
   */
  step: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  /** The span the failing work ran under, so the error shows inside that trace. */
  span?: SpanHandle;
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
  tags?: Record<string, string | number | boolean | bigint | symbol | null | undefined>;
}

// Stack frames live under `.../smoldot/dist/...` or the Bun-versioned
// `.../smoldot@2.0.40/node_modules/smoldot/...`. Both match this.
const SMOLDOT_PATH_RE = /[/\\]smoldot(?:@[\w.+-]+)?[/\\]/i;
// Rust panic messages start with `panicked at /__w/smoldot/...`. The JS
// wrapper raises "Smoldot has panicked" or "Smoldot has crashed".
const SMOLDOT_VALUE_RE = /panicked at [^\n]*[/\\]smoldot[/\\]|Smoldot has (?:panicked|crashed)/i;

const BROWSER_API_ERRORS_INTEGRATION = 'BrowserApiErrors';
const CONSOLE_BREADCRUMBS_INTEGRATION = 'Console';
// `installGlobalErrorHandlers` owns uncaught errors. With Sentry's own handler
// also installed, Sentry reports first and its Dedupe integration then drops
// our copy, so the tags on it never arrive.
const GLOBAL_HANDLERS_INTEGRATION = 'GlobalHandlers';

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
export function excludeBrowserApiErrorsIntegration<T extends { name: string }>(defaultIntegrations: T[]): T[] {
  return defaultIntegrations.filter(integration => integration.name !== BROWSER_API_ERRORS_INTEGRATION);
}

/**
 * Return true when a Sentry event originated from smoldot: either a
 * `CrashError`, a Rust panic message, or a stack frame inside the
 * smoldot package. Exported for unit tests.
 */
export function isSmoldotEvent(event: SmoldotEventLike): boolean {
  const values = event.exception?.values ?? [];
  for (const v of values) {
    if (v.type === 'CrashError') {
      return true;
    }
    if (typeof v.value === 'string' && SMOLDOT_VALUE_RE.test(v.value)) {
      return true;
    }
    const frames = v.stacktrace?.frames ?? [];
    for (const f of frames) {
      const paths = [f.filename, f.module, f.abs_path];
      for (const p of paths) {
        if (typeof p === 'string' && SMOLDOT_PATH_RE.test(p)) {
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
    event.tags = { ...(event.tags ?? {}), smoldot: 'true' };
  }
  return event;
}

/** Sentry `environment` is the deploy domain (e.g. "paseo.li"), derived from
 *  VITE_APP_URL; falls back to "development" when unset or unparseable. */
function sentryEnvironment(): string {
  const appUrl = import.meta.env.VITE_APP_URL;
  if (appUrl === undefined || appUrl === '') {
    return 'development';
  }
  try {
    return new URL(appUrl).hostname;
  } catch {
    return 'development';
  }
}

/**
 * Semver from the build (see `@config/vite/sentry-release`), so Sentry can
 * order releases. The commit is the fallback for a build with no reachable
 * tag, and an empty value counts as unset, as an `.env` line leaves it.
 */
function sentryRelease(): string | undefined {
  const release = import.meta.env.VITE_SENTRY_RELEASE;
  return release !== undefined && release !== '' ? release : import.meta.env.VITE_COMMIT_SHA;
}

/**
 * Initialize Sentry with the dot.li-standard config for the given source
 * and bind it to `@dotli/metrics` so spans/counters flow through. Safe to
 * call unconditionally. When the DSN env var is unset, Sentry becomes a
 * no-op, but we warn loudly instead of silently disabling reporting.
 */
export function initSentry(source: SentrySource): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  const env = sentryEnvironment();
  const extraIntegrations =
    source === 'worker'
      ? []
      : [
          // Overriding the default instance: kill all automatic breadcrumb
          // sources. Sentry.addBreadcrumb() still works.
          Sentry.breadcrumbsIntegration({
            dom: false, // clicks/keypresses (selectors, sometimes text)
            history: false, // URL navigation history
            fetch: false, // request URLs
            xhr: false,
          }),
        ];
  // Console output can carry user data. Sentry 11 records console
  // breadcrumbs in their own default integration, not in Breadcrumbs, so it
  // is dropped wherever the Breadcrumbs override above applies.
  const excludedDefaults =
    source === 'worker'
      ? [GLOBAL_HANDLERS_INTEGRATION]
      : [CONSOLE_BREADCRUMBS_INTEGRATION, GLOBAL_HANDLERS_INTEGRATION];
  Sentry.init({
    dsn,
    tunnel: '/t',
    environment: env,
    release: sentryRelease(),
    beforeSend: tagSmoldotEvents,
    integrations: defaultIntegrations => [
      ...excludeBrowserApiErrorsIntegration(defaultIntegrations).filter(
        integration => !excludedDefaults.includes(integration.name),
      ),
      ...extraIntegrations,
    ],
    // Never attach user info, and never let Sentry infer the user's IP.
    dataCollection: { userInfo: false },
    // Needed so your manual Sentry.startSpan() calls are sent.
    // WITHOUT browserTracingIntegration there is NO automatic
    // pageload, navigation, INP/interaction, fetch, or XHR spans
    tracesSampleRate: 1.0,
    // Don't inject sentry-trace/baggage headers into outgoing requests
    // (avoids leaking trace IDs to third-party endpoints).
    tracePropagationTargets: [],
  });

  // The functions @dotli/metrics calls, by name: binding the namespace
  // itself would keep every export of @sentry/browser (Replay and Feedback
  // among them) in the bundle.
  m.bind({
    startSpan: Sentry.startSpan,
    startInactiveSpan: Sentry.startInactiveSpan,
    setMeasurement: Sentry.setMeasurement,
    metrics: Sentry.metrics,
    setTag: Sentry.setTag,
    addBreadcrumb: Sentry.addBreadcrumb,
  } as unknown as Parameters<typeof m.bind>[0]);
  // Use the canonical schema keys documented in `metrics.ts` (`source`,
  // `env`). The metrics layer owns any Sentry-side prefixing, so pass bare
  // keys here. An already-prefixed key like `dotli_source` would become
  // `dotli.dotli_source` after the mirroring layer's prefix and drift away
  // from the documented schema.
  m.setDefaults({ source, env });
  const commit = import.meta.env.VITE_COMMIT_SHA;
  if (commit !== undefined && commit !== '') {
    // The release names a version; the exact build is still one search away.
    Sentry.setTag('commit', commit);
  }

  // If the DSN is missing in any non-development build, warn loudly once so
  // an operator doesn't lose hours wondering why the dashboard is empty.
  if ((dsn === undefined || dsn === '') && env !== 'development') {
    console.warn(`[dot.li sentry] VITE_SENTRY_DSN missing in env "${env}" — error reporting is DISABLED.`);
  }

  // Wire `log.warn` / `log.error` / `log.event` into Sentry breadcrumbs so
  // handled failures leave a trace in production regardless of `DEBUG`.
  // Inline lookups keep the sink resilient to lazy Sentry initialization.
  bindLogSink({
    emit: (level: LogLevel, message: string, attrs?: Record<string, unknown>, args?: unknown[]) => {
      const sentryLevel: 'info' | 'warning' | 'error' =
        level === 'error' ? 'error' : level === 'warn' ? 'warning' : 'info';
      const { flow, ...data } = attrs ?? {};
      if (args !== undefined && args.length > 0) {
        const errArg = args.find(a => a instanceof Error);
        if (errArg !== undefined) {
          data['error'] = serializeError(errArg);
        }
      }
      Sentry.addBreadcrumb({
        // A breadcrumb that names its flow reads as a step of that flow in
        // the trail rather than as one more log line.
        category: typeof flow === 'string' ? flow : 'log',
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
  if (typeof self === 'undefined') {
    return;
  }

  self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason: unknown = event.reason;
    log.error(`[dot.li ${source}] unhandled rejection:`, reason);
    const err = reason instanceof Error ? reason : nonErrorThrow(reason);
    Sentry.captureException(err, {
      mechanism: { type: 'onunhandledrejection', handled: false },
      captureContext: {
        tags: { kind: 'unhandledrejection', source },
        ...(reason instanceof Error ? {} : { extra: nonErrorExtra(reason) }),
      },
    });
  });

  self.addEventListener('error', (event: ErrorEvent) => {
    log.error(`[dot.li ${source}] window error:`, event.error ?? event.message);
    const extra: Record<string, unknown> = {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      message: event.message,
    };
    const err =
      event.error instanceof Error ? event.error : new Error(event.message || 'window error (no Error object)');
    Sentry.captureException(err, {
      mechanism: { type: 'onerror', handled: false },
      captureContext: {
        tags: { kind: 'window_error', source },
        extra: event.error instanceof Error ? extra : { ...extra, rawError: event.error },
      },
    });
  });
}

/**
 * Report a caught exception as a failure of one step of one user flow.
 *
 * The flow and step become tags and join the issue fingerprint. Errors that
 * crossed a realm boundary are rebuilt at the same receiving line, so their
 * stacks alone would fold every failing step into one issue.
 *
 * Preserves the original `Error` (and its stack). A non-Error throw is
 * captured as a synthetic Error carrying the raw value and its cause chain.
 */
export function captureException(err: unknown, ctx: CaptureContext): void {
  const error = err instanceof Error ? err : nonErrorThrow(err);
  const facts = remoteFacts(err);
  const tags: Record<string, string> = {
    ...ctx.tags,
    flow: ctx.flow,
    step: ctx.step,
    ...(facts.method !== undefined ? { protocol_method: facts.method } : {}),
  };
  const extra: Record<string, unknown> = {
    ...ctx.extra,
    ...(err instanceof Error ? {} : nonErrorExtra(err)),
    ...(facts.remoteStack !== undefined ? { remote_stack: facts.remoteStack } : {}),
  };
  const capture = (): void => {
    Sentry.captureException(error, {
      tags,
      extra,
      fingerprint: ['{{ default }}', ctx.flow, ctx.step],
    });
  };
  const span = ctx.span === undefined ? undefined : sentrySpanOf(ctx.span);
  if (span === undefined) {
    capture();
    return;
  }
  Sentry.withActiveSpan(span as Parameters<typeof Sentry.withActiveSpan>[0], capture);
}

/**
 * Record a failure the app expects and handles, as a breadcrumb rather than
 * an issue: the database closing under a page that is unloading, a wallet held
 * by another tab. It still shows in the trail of any later event, which is
 * where it explains something.
 */
export function recordExpected(err: unknown, ctx: Pick<CaptureContext, 'flow' | 'step'>): void {
  Sentry.addBreadcrumb({
    category: ctx.flow,
    level: 'warning',
    message: `${ctx.step}: ${err instanceof Error ? `${err.name}: ${err.message}` : serializeError(err)}`,
  });
}

/**
 * What an error rebuilt from another realm says about where it came from.
 * The protocol client attaches these to every error it rebuilds from a
 * response envelope (see `ProtocolRequestError`).
 */
function remoteFacts(err: unknown): { method?: string; remoteStack?: string } {
  if (typeof err !== 'object' || err === null) {
    return {};
  }
  const { method, remoteStack } = err as { method?: unknown; remoteStack?: unknown };
  return {
    ...(typeof method === 'string' ? { method } : {}),
    ...(typeof remoteStack === 'string' ? { remoteStack } : {}),
  };
}

function nonErrorThrow(err: unknown): Error {
  const synthetic = new Error(serializeError(err));
  synthetic.name = 'NonErrorThrow';
  return synthetic;
}

function nonErrorExtra(err: unknown): Record<string, unknown> {
  return { rawThrown: err, errorChain: fullErrorChain(err) };
}
