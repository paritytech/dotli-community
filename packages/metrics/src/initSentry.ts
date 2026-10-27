// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import * as Sentry from '@sentry/browser';
import { bindLogSink } from '@dotli/shared';

import { bindCaptureSink } from './captureException.js';
import { sentryLogSink } from './sentryLogSink.js';
import { tagSmoldotEvents } from './isSmoldotEvent.js';
import { m } from './metrics.js';
import { sentryCaptureSink } from './sentryCaptureSink.js';

/** All surfaces report to one Sentry project, and this `source` tag tells them apart. */
export type SentrySource = 'host' | 'protocol' | 'worker' | 'sandbox';

// Read in this module, not shared, so the metrics-off build drops the SDK.
const METRICS_ENABLED = import.meta.env.VITE_METRICS === 'true';

/** Initialize Sentry and bind it to `m`. Safe without a DSN, where a non-development build warns once. */
export function initSentry(source: SentrySource): void {
  if (!METRICS_ENABLED) {
    return;
  }
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  const environment = getSentryEnvironment();
  const client = new Sentry.BrowserClient({
    dsn,
    tunnel: '/t',
    environment,
    release: getSentryRelease(),
    beforeSend: tagSmoldotEvents,
    integrations: listIntegrations(source),
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

  bindCaptureSink(sentryCaptureSink);

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
  m.setDefaults({ source, env: environment });
  const commit = import.meta.env.VITE_COMMIT_SHA;
  if (commit !== undefined && commit !== '') {
    // The release names a version, this tag pins the exact build.
    Sentry.setTag('commit', commit);
  }

  if ((dsn === undefined || dsn === '') && environment !== 'development') {
    // eslint-disable-next-line no-console -- error reporting is off, so the console is the only place to say so
    console.warn(`[dot.li sentry] VITE_SENTRY_DSN missing in env "${environment}". Error reporting is DISABLED.`);
  }

  // Handled failures leave a breadcrumb trail in production regardless of `DEBUG`.
  bindLogSink(sentryLogSink);
}

function getSentryEnvironment(): string {
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
function getSentryRelease(): string | undefined {
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
function listIntegrations(source: SentrySource) {
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
