// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { fakeDebugPanelHost } from '@dotli/truapi-debug-ui/testing';
import { debugPanelHost, startDebugPanel, type DebugPanelParts } from './debug-panel.js';

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
      options: { startCollapsed: true },
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
      options: { startCollapsed: false },
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
      options: { startCollapsed: false },
    });

    // Then
    await expect(started).resolves.toBeUndefined();
    expect(setupTruapiDebugPanel).not.toHaveBeenCalled();
    expect(captures.exception).toHaveBeenCalledTimes(1);
    expect(captures.exception).toHaveBeenCalledWith(failure, { flow: 'ui', step: 'debug_panel_load' });
    expect(counted('debug_panel.load')).toContainEqual({ outcome: 'error', reason: 'TypeError' });
  });
});

/** The page's parts over a fake host, with `overrides` for what a test watches. */
function parts(overrides: Partial<DebugPanelParts> = {}): DebugPanelParts {
  const { host } = fakeDebugPanelHost();
  return {
    product: host.product,
    auth: host.auth,
    walletMode: host.walletMode,
    walletSwitch: host.walletSwitch,
    phraseToEntropy: host.phraseToEntropy,
    diagnostics: host.diagnostics,
    readArchive: () => Promise.resolve({}),
    viaGateway: () => false,
    topbarPresent: () => false,
    setDockInset: () => undefined,
    leaveDebugMode: () => undefined,
    ...overrides,
  };
}

describe('debugPanelHost', () => {
  it("As a dotli developer on the light client, the Archive tab reads blocks from the host's sandbox relay", async () => {
    // Given
    const readArchive = vi.fn<DebugPanelParts['readArchive']>(() => Promise.resolve({}));
    const blockSource = vi.fn(() => Promise.resolve(new Uint8Array()));
    const { archive } = debugPanelHost(parts({ readArchive, viaGateway: () => false }), blockSource);

    // When
    await archive('bafyroot');

    // Then
    expect(readArchive).toHaveBeenCalledExactlyOnceWith('bafyroot', { blockSource });
  });

  it('As a dotli developer on rpc-gateway, the Archive tab reads from the IPFS gateway, as the sandbox reads it', async () => {
    // Given
    const readArchive = vi.fn<DebugPanelParts['readArchive']>(() => Promise.resolve({}));
    const blockSource = vi.fn(() => Promise.resolve(new Uint8Array()));
    let gateway = false;
    const { archive } = debugPanelHost(parts({ readArchive, viaGateway: () => gateway }), blockSource);

    // When the backend switches after the panel was built
    gateway = true;
    await archive('bafyroot');

    // Then
    expect(readArchive).toHaveBeenCalledExactlyOnceWith('bafyroot', { gateway: true });
    expect(blockSource).not.toHaveBeenCalled();
  });

  it("As the debug panel, Hide reaches the page's way out of debug mode", () => {
    // Given
    const leaveDebugMode = vi.fn();
    const host = debugPanelHost(parts({ leaveDebugMode }), () => Promise.resolve(new Uint8Array()));

    // When
    host.leaveDebugMode();

    // Then
    expect(leaveDebugMode).toHaveBeenCalledTimes(1);
  });

  it('As the debug panel, the room I report reaches the frame layout as the debug dock', () => {
    // Given
    const setDockInset = vi.fn<DebugPanelParts['setDockInset']>();
    const host = debugPanelHost(parts({ setDockInset }), () => Promise.resolve(new Uint8Array()));

    // When
    host.reportDockInset({ right: 0, bottom: 360 });

    // Then
    expect(setDockInset).toHaveBeenCalledExactlyOnceWith({ right: 0, bottom: 360 }, 'debug');
  });

  it("As the debug panel, I dock against the page's own content edges", () => {
    // When
    const host = debugPanelHost(parts(), () => Promise.resolve(new Uint8Array()));

    // Then
    expect(host.contentInsets).toEqual({ top: 'var(--content-top)', bottom: 'var(--content-bottom)' });
  });
});
