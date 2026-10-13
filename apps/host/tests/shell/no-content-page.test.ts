// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getActiveTldSuffix } from '@dotli/config';
import { disposeContentRoots } from '@dotli/ui-core';
import { createRecordingReporter } from '@dotli/ui-core/testing';
import { byTestId } from '@dotli/ui/testing';
import type { NoContentPageModule } from '../../src/lazy.js';
import { showNoContentError } from '../../src/no-content-page.js';

const XSS = '<img src=x onerror="alert(1)">';

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
  disposeContentRoots();
  document.body.innerHTML = '';
});

describe('no-content page', () => {
  it('As a visitor, when the page view cannot load, I still read that the app cannot be reached and the name to check, as text with no icon', async () => {
    // Given
    const report = createRecordingReporter();
    const load = (): Promise<NoContentPageModule> => Promise.reject(new Error('chunk missing'));

    // When
    await showNoContentError(XSS, { load, report });

    // Then
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('svg')).toBeNull();
    expect(byTestId('error-page-title').textContent).toBe("This app can't be reached");
    expect(byTestId('error-page-detail').textContent).toBe(`Check if there is a typo in ${XSS}${getActiveTldSuffix()}`);
    expect(report.failures.map(f => f.context)).toEqual([
      { flow: 'ui', step: 'root_load', tags: { root: 'no-content-page', kind: 'no-content-page_load_error' } },
    ]);
  });
});
