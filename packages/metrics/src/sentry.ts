// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The one module that imports the SDK. Its calls sit behind the compile-time metrics flag.

import * as Sentry from '@sentry/browser';
import {
  bindLogSink,
  errorName,
  log,
  type LogLevel,
  serializeError,
  fullErrorChain,
  StoreListenerError,
} from '@dotli/shared';

import { bindCaptureSink, captureException, type CaptureSink } from './capture.js';
import { m, sentrySpanOf } from './metrics.js';
import * as S from './spans.js';

// Compile-time, so a build without metrics drops every SDK call with these branches.
const ENABLED = import.meta.env.VITE_METRICS === 'true';

/** All surfaces report to one Sentry project, and this `source` tag tells them apart. */
export type SentrySource = 'host' | 'protocol' | 'worker' | 'sandbox';

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

/**
 * Listed rather than filtered from the defaults, so the bundle carries only these. Left out on purpose:
 * `globalHandlers` (`installGlobalErrorHandlers` owns uncaught errors, and with both on Dedupe drops our tagged copy),
 * `browserApiErrors` (`@polkadot-api/utils` registers `Function.prototype` as a listener, and once Sentry marks it
 * wrapped every later callback looks wrapped and becomes a no-op), and on pages the console capture, since console output
 * can carry user data. Pages keep the breadcrumb trail of earlier events and drop its automatic DOM, history and
 * network capture. `addBreadcrumb` works without them.
 * Unlike `Sentry.init`, this skips the SDK's own stringifier for Window, Document and elements in `extra`, which dotli
 * never sends.
 */
function integrationsFor(source: SentrySource) {
  const kept = [
    Sentry.eventFiltersIntegration(),
    Sentry.functionToStringIntegration(),
    Sentry.linkedErrorsIntegration(),
    Sentry.dedupeIntegration(),
    Sentry.httpContextIntegration(),
    Sentry.cultureContextIntegration(),
    Sentry.browserSessionIntegration(),
  ];
  return source === 'worker'
    ? [...kept, Sentry.breadcrumbsIntegration(), Sentry.consoleIntegration()]
    : [...kept, Sentry.breadcrumbsIntegration({ dom: false, fetch: false, history: false, xhr: false })];
}

/** Initialize Sentry and bind it to `m`. Safe without a DSN, where a non-development build warns once. */
export function initSentry(source: SentrySource): void {
  if (!ENABLED) {
    return;
  }
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  const env = sentryEnvironment();
  const client = new Sentry.BrowserClient({
    dsn,
    tunnel: '/t',
    environment: env,
    release: sentryRelease(),
    beforeSend: tagSmoldotEvents,
    integrations: integrationsFor(source),
    transport: Sentry.makeFetchTransport,
    stackParser: Sentry.defaultStackParser,
    // Never attach user info or let Sentry infer the IP.
    dataCollection: { userInfo: false },
    // Sends the manual spans. Without browserTracingIntegration nothing is traced automatically.
    tracesSampleRate: 1.0,
    // No sentry-trace or baggage headers, so trace ids never reach third parties.
    tracePropagationTargets: [],
  });
  Sentry.getCurrentScope().setClient(client);
  client.init();

  bindCaptureSink(sentrySink);

  m.bind({
    startSpan: Sentry.startSpan,
    startInactiveSpan: Sentry.startInactiveSpan,
    setMeasurement: Sentry.setMeasurement,
    metrics: Sentry.metrics,
    setTag: Sentry.setTag,
    addBreadcrumb: Sentry.addBreadcrumb,
    // The structural view keeps the parent span opaque and passes unset options as `undefined`, which the SDK's exact
    // optional types refuse though it reads them as absent.
  } as unknown as Parameters<typeof m.bind>[0]);
  m.setDefaults({ source, env });
  const commit = import.meta.env.VITE_COMMIT_SHA;
  if (commit !== undefined && commit !== '') {
    // The release names a version, this tag pins the exact build.
    Sentry.setTag('commit', commit);
  }

  if ((dsn === undefined || dsn === '') && env !== 'development') {
    // eslint-disable-next-line no-console -- error reporting is off, so the console is the only place to say so
    console.warn(`[dot.li sentry] VITE_SENTRY_DSN missing in env "${env}". Error reporting is DISABLED.`);
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
 * Sends what Sentry has buffered, waiting at most `timeoutMs`. Resolves at once when metrics are off, and never
 * rejects, since its callers are on their way out. A failure is reported best effort.
 */
export async function flushTelemetry(timeoutMs: number): Promise<void> {
  if (!ENABLED) {
    return;
  }
  try {
    await Sentry.flush(timeoutMs);
  } catch (err: unknown) {
    log.error('[dot.li sentry] flush failed', err);
    captureException(err, { flow: 'protocol', step: 'flush_telemetry' });
    m.count(S.TELEMETRY_FLUSH, { outcome: 'error', reason: errorName(err) ?? 'unknown' });
  }
}

/**
 * Route uncaught errors and rejections to Sentry.
 * An `Error` passes unwrapped to keep its stack, and an `ErrorEvent` keeps its location even when
 * `event.error` is null (resource-load failures, CORS-tainted scripts).
 */
export function installGlobalErrorHandlers(source: SentrySource): void {
  if (!ENABLED || typeof self === 'undefined') {
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
    if (event.error instanceof StoreListenerError) {
      log.error(`[dot.li ${source}] store listener failed:`, event.error);
      // The listener's own error keeps the issue title and grouping of its real type, and the log line names the store.
      sentrySink.exception(event.error.cause instanceof Error ? event.error.cause : event.error, {
        flow: 'ui',
        step: 'store_listener',
        tags: { store: event.error.store, kind: 'store_listener_error', source },
      });
      return;
    }
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

/** Sends captures to Sentry. Bound by `initSentry`, so before it runs captures drop. */
const sentrySink: CaptureSink = {
  exception: (err, ctx) => {
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
  },
  expected: (err, ctx) => {
    Sentry.addBreadcrumb({
      category: ctx.flow,
      level: 'warning',
      message: `${ctx.step}: ${err instanceof Error ? `${err.name}: ${err.message}` : serializeError(err)}`,
    });
  },
};

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
