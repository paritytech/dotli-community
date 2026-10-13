// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '@dotli/shared/testing';
import { disposeContentRoots, registerAppRoot } from '@dotli/ui-core';
import { createRecordingReporter } from '@dotli/ui-core/testing';
import { ReloadIcon } from '@dotli/ui/icons';
import { byId, byTestId, settle } from '@dotli/ui/testing';
import { createErrorPage, type ErrorPageMountModule } from '../../src/error-page/error-page.js';

const XSS = '<img src=x onerror="alert(1)">';

/** For what may be absent, since the page queries throw on a miss. */
function shown(testId: string): Element | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

const missingChunk = (): Promise<ErrorPageMountModule> => Promise.reject(new Error('chunk missing'));

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
  disposeContentRoots();
  document.body.innerHTML = '';
});

describe('error page', () => {
  it('As a visitor, when the page view cannot load, I still read the page as text with working buttons and no icon, and the miss is reported once', async () => {
    // Given
    const report = createRecordingReporter();
    const { showErrorPage } = createErrorPage(report, missingChunk);
    const onClick = vi.fn();

    // When
    await showErrorPage({
      title: XSS,
      detail: [XSS, ' and ', { strong: XSS }],
      tips: [XSS],
      actions: [{ label: 'Reload', icon: ReloadIcon, onClick }],
    });
    byTestId('error-page-retry-label').click();

    // Then
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('svg')).toBeNull();
    expect(shown('error-page-glyph')).toBeNull();
    expect(byTestId('error-page-title').textContent).toBe(XSS);
    expect(byTestId('error-page-detail').textContent).toBe(`${XSS} and ${XSS}`);
    expect(byTestId('error-page-tips-list').textContent).toBe(XSS);
    expect(byId('error-retry-btn').textContent).toBe('Reload');
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(byTestId('error-page-title'));
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.context).toEqual({
      flow: 'ui',
      step: 'root_load',
      tags: { root: 'error-page', kind: 'error-page_load_error' },
    });
  });

  it('As a visitor, the text page goes when a later full-page screen takes the page over', async () => {
    // Given
    const { showErrorPage } = createErrorPage(createRecordingReporter(), missingChunk);
    await showErrorPage({ title: 'Failed' });

    // When
    disposeContentRoots();

    // Then
    expect(shown('error-page')).toBeNull();
  });

  it('As the shell, the page disposes the content roots before its chunk arrives, then mounts its view as a content root', async () => {
    // Given
    const disposed = vi.fn();
    registerAppRoot('page', disposed, vi.fn(), { content: true });
    const { showErrorPage } = createErrorPage(createRecordingReporter());

    // When
    const showing = showErrorPage({
      title: 'Failed',
      actions: [{ label: 'Reload', icon: ReloadIcon, onClick: vi.fn() }],
    });

    // Then
    expect(disposed).toHaveBeenCalledTimes(1);
    await showing;
    await settle();
    expect(byTestId('error-page-title').textContent).toBe('Failed');
    expect(byTestId('error-page-icon', document, SVGSVGElement)).toBeDefined();
    expect(byTestId('error-page-action-icon', document, SVGSVGElement)).toBeDefined();

    // When
    disposeContentRoots();

    // Then
    expect(shown('error-page')).toBeNull();
  });

  it('As a visitor, a page shown while an earlier one is still loading is the one I see', async () => {
    // Given an error page whose chunk is still on its way
    const slow = deferred<ErrorPageMountModule>();
    const first = createErrorPage(createRecordingReporter(), () => slow.promise).showErrorPage({ title: 'First' });

    // When a second one shows, then the first one's chunk arrives
    await createErrorPage(createRecordingReporter(), missingChunk).showErrorPage({ title: 'Second' });
    slow.resolve(await import('../../src/error-page/mount.js'));
    await first;
    await settle();

    // Then
    expect([...document.querySelectorAll('[data-testid="error-page-title"]')].map(t => t.textContent)).toEqual([
      'Second',
    ]);
  });
});
