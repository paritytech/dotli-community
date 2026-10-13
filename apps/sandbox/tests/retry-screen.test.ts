// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { disposeContentRoots } from '@dotli/ui-core';
import { createRecordingReporter } from '@dotli/ui-core/testing';
import { byTestId } from '@dotli/ui/testing';
import type { RetryScreenModule } from '../src/lazy.js';
import { showRetryScreen } from '../src/retry-screen.js';

afterEach(() => {
  disposeContentRoots();
  document.body.replaceChildren();
});

describe('retry screen', () => {
  it('As a visitor whose app is starting again, when the screen view cannot load, I still read that it is retrying, with no mark', async () => {
    // Given
    const report = createRecordingReporter();
    const load = (): Promise<RetryScreenModule> => Promise.reject(new Error('chunk missing'));

    // When
    await showRetryScreen({ load, report });

    // Then
    expect(document.querySelector('svg')).toBeNull();
    expect(byTestId('retry-screen').textContent).toBe("Retrying…The app's connection dropped, so it is starting again");
    expect(report.failures.map(f => f.context)).toEqual([
      { flow: 'ui', step: 'root_load', tags: { root: 'retry-screen', kind: 'retry-screen_load_error' } },
    ]);
  });

  it('As a visitor whose app is starting again, I see the pulsing mark over what is happening', async () => {
    // When
    await showRetryScreen({ load: () => import('../src/RetryScreen.js'), report: createRecordingReporter() });

    // Then
    expect(byTestId('retry-screen-mark', document, SVGSVGElement).querySelectorAll('path')).toHaveLength(6);
    expect(byTestId('retry-screen').textContent).toContain('Retrying…');
  });
});
