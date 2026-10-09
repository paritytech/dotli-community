// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Apart from `metrics.ts` so callers of `m` alone get a bundle without `@sentry/browser`.

import * as Sentry from '@sentry/browser';
import { bindLogSink, log, type LogLevel, serializeError, fullErrorChain } from '@dotli/shared';

import { m, sentrySpanOf, type SpanHandle } from './metrics.js';

/** All surfaces report to one Sentry project, and this `source` tag tells them apart. */
export type SentrySource = 'host' | 'protocol' | 'worker' | 'sandbox';

/** The user flow an event belongs to, so failures can be read and counted per flow from tags alone. */
export type Flow =
  'boot' | 'resolve' | 'content' | 'protocol' | 'wallet' | 'storage' | 'notifications' | 'pwa' | 'ui' | 'chat';

export interface CaptureContext {
  flow: Flow;
  /**
   * The failing step in snake_case (`manifest_read`). Part of the issue fingerprint, so keep it
   * stable and low-cardinality: never a label, CID or message.
   */
  step: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  /** The error shows inside this span's trace. */
  span?: SpanHandle;
}

/** Structural view of a Sentry event, so tests need no SDK types. */
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

// Matches `.../smoldot/dist/...` and the Bun-versioned `.../smoldot@2.0.40/node_modules/smoldot/...`.
const SMOLDOT_PATH_RE = /[/\\]smoldot(?:@[\w.+-]+)?[/\\]/i;
// Rust panics read `panicked at /__w/smoldot/...`, the JS wrapper "Smoldot has panicked" or "crashed".
const SMOLDOT_VALUE_RE = /panicked at [^\n]*[/\\]smoldot[/\\]|Smoldot has (?:panicked|crashed)/i;

const BROWSER_API_ERRORS_INTEGRATION = 'BrowserApiErrors';
const CONSOLE_BREADCRUMBS_INTEGRATION = 'Console';
// `installGlobalErrorHandlers` owns uncaught errors. With Sentry's handler also on, Dedupe drops our tagged copy.
const GLOBAL_HANDLERS_INTEGRATION = 'GlobalHandlers';

/**
 * Drop Sentry's BrowserApiErrors callback wrapper.
 * `@polkadot-api/utils` registers `Function.prototype` as a listener on disconnect. Marking it
 * `__sentry_wrapped__` makes every later callback look wrapped, so Sentry swaps them all for a no-op.
 */
export function excludeBrowserApiErrorsIntegration<T extends { name: string }>(defaultIntegrations: T[]): T[] {
  return defaultIntegrations.filter(integration => integration.name !== BROWSER_API_ERRORS_INTEGRATION);
}

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

/** Tagged in `beforeSend` because smoldot crashes reach Sentry through its own integrations as well as ours. */
function tagSmoldotEvents<E extends SmoldotEventLike>(event: E): E {
  if (isSmoldotEvent(event)) {
    event.tags = { ...(event.tags ?? {}), smoldot: 'true' };
  }
  return event;
}

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

/** Semver so Sentry can order releases, else the commit. An empty `.env` line counts as unset. */
function sentryRelease(): string | undefined {
  const release = import.meta.env.VITE_SENTRY_RELEASE;
  return release !== undefined && release !== '' ? release : import.meta.env.VITE_COMMIT_SHA;
}

/** Initialize Sentry and bind it to `m`. Safe without a DSN, where a non-development build warns once. */
export function initSentry(source: SentrySource): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  const env = sentryEnvironment();
  const extraIntegrations =
    source === 'worker'
      ? []
      : [
          // Replaces the default instance so nothing is collected automatically. `addBreadcrumb` still works.
          Sentry.breadcrumbsIntegration({
            dom: false, // selectors and sometimes text
            history: false,
            fetch: false,
            xhr: false,
          }),
        ];
  // Console output can carry user data, and Sentry 11 records it in its own integration, not Breadcrumbs.
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
    // Never attach user info or let Sentry infer the IP.
    dataCollection: { userInfo: false },
    // Sends the manual spans. Without browserTracingIntegration nothing is traced automatically.
    tracesSampleRate: 1.0,
    // No sentry-trace or baggage headers, so trace ids never reach third parties.
    tracePropagationTargets: [],
  });

  m.bind({
    startSpan: Sentry.startSpan,
    startInactiveSpan: Sentry.startInactiveSpan,
    setMeasurement: Sentry.setMeasurement,
    metrics: Sentry.metrics,
    setTag: Sentry.setTag,
    addBreadcrumb: Sentry.addBreadcrumb,
  } as unknown as Parameters<typeof m.bind>[0]);
  m.setDefaults({ source, env });
  const commit = import.meta.env.VITE_COMMIT_SHA;
  if (commit !== undefined && commit !== '') {
    // The release names a version, this tag pins the exact build.
    Sentry.setTag('commit', commit);
  }

  if ((dsn === undefined || dsn === '') && env !== 'development') {
    console.warn(`[dot.li sentry] VITE_SENTRY_DSN missing in env "${env}" — error reporting is DISABLED.`);
  }

  // Handled failures leave a breadcrumb trail in production regardless of `DEBUG`.
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
        category: typeof flow === 'string' ? flow : 'log',
        level: sentryLevel,
        message,
        data,
      });
    },
  });
}

/**
 * Route uncaught errors and rejections to Sentry.
 * An `Error` passes unwrapped to keep its stack, and an `ErrorEvent` keeps its location even when
 * `event.error` is null (resource-load failures, CORS-tainted scripts).
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
 * Report a caught exception as a failure of one flow step.
 * Flow and step join the fingerprint because errors rebuilt from another realm share one receiving stack.
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

/** Record an expected, handled failure as a breadcrumb rather than an issue, to explain any later event. */
export function recordExpected(err: unknown, ctx: Pick<CaptureContext, 'flow' | 'step'>): void {
  Sentry.addBreadcrumb({
    category: ctx.flow,
    level: 'warning',
    message: `${ctx.step}: ${err instanceof Error ? `${err.name}: ${err.message}` : serializeError(err)}`,
  });
}

/** Origin facts the protocol client attaches to errors it rebuilds from a response envelope. */
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
