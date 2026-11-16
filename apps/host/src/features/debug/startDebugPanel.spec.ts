// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { fakeDebugPanelHost } from '@dotli/truapi-debug-ui/testing';
import { startDebugPanel } from './startDebugPanel.js';

/** The sinks a failure reaches, bound until the case ends. */
type RecordingSinks = {
  captures: { exception: Mock; expected: Mock };
  counted: RecordingSentry['counted'];
};

describe('startDebugPanel', () => {
  it('As a dotli developer, I start the debug panel and it mounts with the options the page gives it', async () => {
    // Given
    const { captures, counted } = bindRecordingSinks();
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

  it('As a dotli developer whose debug panel chunk fails to load, I start the panel and the failure is reported once while the page goes on', async () => {
    // Given
    const { captures, counted } = bindRecordingSinks();
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
    expect(captures.exception).toHaveBeenCalledWith(failure, expect.objectContaining({ step: 'debug_panel_load' }));
    expect(counted('debug_panel.load')).toContainEqual({ outcome: 'error', reason: 'TypeError' });
  });

  it('As a dotli developer whose debug panel host parts fail to load, I start the panel and the failure is reported once while the page goes on', async () => {
    // Given
    const { captures, counted } = bindRecordingSinks();
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
    expect(captures.exception).toHaveBeenCalledWith(failure, expect.objectContaining({ step: 'debug_panel_load' }));
    expect(counted('debug_panel.load')).toContainEqual({ outcome: 'error', reason: 'TypeError' });
  });
});

/** Binds recording capture and metric sinks until the case ends. */
function bindRecordingSinks(): RecordingSinks {
  const captures = { exception: vi.fn(), expected: vi.fn() };
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  onTestFinished(bindCaptureSink(captures));
  return { captures, counted: metrics.counted };
}
