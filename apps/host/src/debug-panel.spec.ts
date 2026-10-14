// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { fakeDebugPanelHost } from '@dotli/truapi-debug-ui/testing';
import { startDebugPanel } from './debug-panel.js';

const restores: (() => void)[] = [];

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) {
    restore();
  }
});

function record(): {
  captures: { exception: ReturnType<typeof vi.fn>; expected: ReturnType<typeof vi.fn> };
  counted: RecordingSentry['counted'];
} {
  const captures = { exception: vi.fn(), expected: vi.fn() };
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  restores.push(bindCaptureSink(captures));
  return { captures, counted: metrics.counted };
}

describe('startDebugPanel', () => {
  it('As a dotli developer, the debug panel mounts with the options the page gives it', async () => {
    // Given
    const { captures, counted } = record();
    const setupTruapiDebugPanel = vi.fn(() => () => undefined);
    const { host } = fakeDebugPanelHost();

    // When
    await startDebugPanel({
      load: () => Promise.resolve({ setupTruapiDebugPanel }),
      host: () => Promise.resolve(host),
      startCollapsed: true,
    });

    // Then
    expect(setupTruapiDebugPanel).toHaveBeenCalledWith({ startCollapsed: true, host });
    expect(captures.exception).not.toHaveBeenCalled();
    expect(counted('debug_panel.load')).toContainEqual({ outcome: 'ok' });
  });

  it('As a dotli developer whose debug panel chunk fails to load, the failure is reported once and the page goes on', async () => {
    // Given
    const { captures, counted } = record();
    const failure = new TypeError('Failed to fetch dynamically imported module');

    // When
    const started = startDebugPanel({
      load: () => Promise.reject(failure),
      host: () => Promise.resolve(fakeDebugPanelHost().host),
      startCollapsed: false,
    });

    // Then
    await expect(started).resolves.toBeUndefined();
    expect(captures.exception).toHaveBeenCalledTimes(1);
    expect(captures.exception).toHaveBeenCalledWith(failure, { flow: 'ui', step: 'debug_panel_load' });
    expect(counted('debug_panel.load')).toContainEqual({ outcome: 'error', reason: 'TypeError' });
  });

  it('As a dotli developer whose debug panel host parts fail to load, the failure is reported once and the page goes on', async () => {
    // Given
    const { captures, counted } = record();
    const failure = new TypeError('Failed to fetch dynamically imported module');
    const setupTruapiDebugPanel = vi.fn(() => () => undefined);

    // When
    const started = startDebugPanel({
      load: () => Promise.resolve({ setupTruapiDebugPanel }),
      host: () => Promise.reject(failure),
      startCollapsed: false,
    });

    // Then
    await expect(started).resolves.toBeUndefined();
    expect(setupTruapiDebugPanel).not.toHaveBeenCalled();
    expect(captures.exception).toHaveBeenCalledTimes(1);
    expect(captures.exception).toHaveBeenCalledWith(failure, { flow: 'ui', step: 'debug_panel_load' });
    expect(counted('debug_panel.load')).toContainEqual({ outcome: 'error', reason: 'TypeError' });
  });
});
