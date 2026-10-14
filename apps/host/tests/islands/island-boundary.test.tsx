// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { render, type JSX } from '@solidjs/web';
import { bindCaptureSink } from '@dotli/metrics';
import { RootBoundary } from '@dotli/ui';
import { settle } from '@dotli/ui/testing';
import { reportIslandErrors } from '../../src/island-errors.js';

afterEach(() => {
  document.body.replaceChildren();
});

describe('island boundary', () => {
  it('As a visitor, an island that breaks while rendering is reported once, shows nothing and stands in with its onBroken, with no reload offer', async () => {
    // Given
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const onBroken = vi.fn();
    const notify = vi.fn();
    onTestFinished(reportIslandErrors({ target: document, notify, reload: vi.fn() }));
    const failure = new Error('island render failed');
    const Failing = (): JSX.Element => {
      throw failure;
    };
    const host = document.createElement('div');
    document.body.append(host);

    // When
    onTestFinished(
      render(
        () => (
          <RootBoundary root="island:Test" onBroken={onBroken}>
            <Failing />
          </RootBoundary>
        ),
        host,
      ),
    );
    await settle();

    // Then
    expect(captures.exception).toHaveBeenCalledTimes(1);
    expect(captures.exception).toHaveBeenCalledWith(failure, {
      flow: 'ui',
      step: 'root_render',
      tags: { root: 'island:Test' },
    });
    expect(onBroken).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(host.textContent).toBe('');
  });
});
