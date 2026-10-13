// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink, type CaptureContext } from '@dotli/metrics';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { bindLogSink, type LogLevel } from '@dotli/shared';
import type { ErrorPageContent } from '@dotli/ui-widgets';
import { OPEN_SETTINGS_BTN_LABEL, RELOAD_BTN_LABEL, type ErrorDescription } from './errors.js';
import type { LoadFailureModule } from './lazy.js';
import { createSessionErrorSightings, showLoadFailure } from './show-load-failure.js';

type Page = ErrorPageContent;

const ERROR: ErrorDescription = {
  kind: 'hub-sync-timeout',
  title: 'The network took too long',
  message: 'Your light client could not catch up.',
  recovery: 'switch-backend',
  tips: ['Waiting a moment.'],
};

interface Harness {
  pages: Page[];
  captures: { err: unknown; ctx: CaptureContext }[];
  errors: string[];
  /** Breadcrumbs, by message. */
  events: string[];
  counted: RecordingSentry['counted'];
  show: (load: () => Promise<LoadFailureModule>) => Promise<void>;
}

function harness(): Harness {
  const pages: Page[] = [];
  const captures: { err: unknown; ctx: CaptureContext }[] = [];
  const errors: string[] = [];
  const events: string[] = [];
  onTestFinished(
    bindCaptureSink({
      exception: (err, ctx) => {
        captures.push({ err, ctx });
      },
      expected: () => undefined,
    }),
  );
  onTestFinished(
    bindLogSink({
      emit: (level: LogLevel, message: string) => {
        if (level === 'error') {
          errors.push(message);
        } else if (level === 'info') {
          events.push(message);
        }
      },
    }),
  );
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const show = (load: () => Promise<LoadFailureModule>): Promise<void> =>
    showLoadFailure(
      { error: ERROR, cause: new Error('hub sync timed out'), label: 'doom', backend: 'smoldot-direct' },
      {
        load,
        showErrorPage: (page: Page) => {
          pages.push(page);
        },
        openSettings: vi.fn(),
        reload: vi.fn(),
        switchBackend: vi.fn(),
        resetProtocolOnReload: vi.fn(),
        sightings: { seen: () => false, remember: vi.fn() },
        emit: vi.fn(),
      },
    );
  return { pages, captures, errors, events, counted: metrics.counted, show };
}

describe('showLoadFailure', () => {
  it('As a visitor on a failed load, I see its recovery screen once the screen code loads', async () => {
    // Given
    const { pages, counted, show } = harness();

    // When
    await show(() => import('./load-failure.js'));

    // Then
    expect(pages).toHaveLength(1);
    expect(pages[0]?.title).toBe(ERROR.title);
    expect((pages[0]?.actions ?? []).map(action => action.label)).toEqual([RELOAD_BTN_LABEL, OPEN_SETTINGS_BTN_LABEL]);
    expect(counted('failure_screen.load')).toEqual([{ outcome: 'ok' }]);
  });

  it('As a visitor whose failure screen code cannot be fetched, I still see why the load failed, and the miss is reported', async () => {
    // Given
    const { pages, captures, errors, counted, show } = harness();
    const chunkError = new TypeError('Failed to fetch dynamically imported module');

    // When
    await show(() => Promise.reject(chunkError));

    // Then
    expect(pages).toEqual([{ title: ERROR.title, detail: ERROR.message, tips: ERROR.tips }]);
    expect(captures).toHaveLength(1);
    expect(captures[0]?.err).toBe(chunkError);
    expect(captures[0]?.ctx).toMatchObject({ flow: 'resolve', step: 'failure_screen_load' });
    expect(errors).toHaveLength(1);
    expect(counted('failure_screen.load')).toEqual([{ outcome: 'error', reason: 'chunk_load' }]);
  });

  it('As a visitor on a failed load, I leave one error page breadcrumb whether the screen code loads or not', async () => {
    // Given
    const { events, show } = harness();

    // When
    await show(() => import('./load-failure.js'));
    await show(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module')));

    // Then
    expect(events.filter(message => message === 'Error page shown')).toHaveLength(2);
  });
});

describe('sessionErrorSightings', () => {
  it('As a visitor reloading after a failure, I find the sighting kept for this tab until it is forgotten', () => {
    // Given the tab's session storage
    const session = new Map<string, string>();
    const sessionErrorSightings = createSessionErrorSightings(() => ({
      getItem: key => session.get(key) ?? null,
      setItem: (key, value) => {
        session.set(key, value);
      },
      removeItem: key => {
        session.delete(key);
      },
    }));
    sessionErrorSightings.remember('hub-sync-timeout');

    // When
    const kept = sessionErrorSightings.seen('hub-sync-timeout');
    const other = sessionErrorSightings.seen('rpc-timeout');
    sessionErrorSightings.forget();

    // Then
    expect(kept).toBe(true);
    expect(other).toBe(false);
    expect(sessionErrorSightings.seen('hub-sync-timeout')).toBe(false);
  });
});
